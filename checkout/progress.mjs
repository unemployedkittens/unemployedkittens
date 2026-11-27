import { createHash } from 'node:crypto';

const stages = [
  { name: 'Payment confirmed', percent: 20, stage: 1 },
  { name: 'Grounded AI search complete', percent: 40, stage: 2 },
  { name: 'Negotiation', percent: 50, stage: 3, negotiated: 10 },
  { name: 'Negotiation', percent: 60, stage: 3, negotiated: 20 },
  { name: 'Negotiation', percent: 70, stage: 3, negotiated: 30 },
  { name: 'Tidying the data', percent: 85, stage: 4 },
  { name: 'Job complete', percent: 100, stage: 5 }
];

const commands = new Map([['search', 1], ['10', 2], ['20', 3], ['30', 4], ['tidying', 5]]);
const pageSize = 24;

export function createRentalProgress(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS rental_progress (
      request_id TEXT PRIMARY KEY REFERENCES rentals(request_id),
      milestone INTEGER NOT NULL CHECK (milestone BETWEEN 1 AND 5)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS rentals_by_paid_date ON rentals (paid_at DESC, request_id DESC)
      WHERE status = 'paid';
  `);
  const paid = `
    SELECT rentals.request_id, COALESCE(rental_progress.milestone, 0) AS milestone,
           rental_completion.request_id IS NOT NULL AS complete
    FROM rentals
    LEFT JOIN rental_progress ON rental_progress.request_id = rentals.request_id
    LEFT JOIN rental_completion ON rental_completion.request_id = rentals.request_id
    WHERE rentals.status = 'paid'
  `;
  const findPaid = database.prepare(`${paid} AND rentals.tracking_id = ?`);
  const listPaid = database.prepare(`
    ${paid} ORDER BY rentals.paid_at DESC, rentals.request_id DESC LIMIT ? OFFSET ?
  `);
  const setMilestone = database.prepare(`
    INSERT INTO rental_progress (request_id, milestone) VALUES (?, ?)
    ON CONFLICT(request_id) DO UPDATE SET milestone = excluded.milestone
    WHERE rental_progress.milestone < excluded.milestone
  `);

  function publicJob(row) {
    const identity = createHash('sha256').update('public-kitten-job:').update(row.request_id).digest('hex');
    const status = stages[row.complete ? stages.length - 1 : row.milestone];
    return { job: identity.slice(0, 10).toUpperCase(), ...status };
  }

  return {
    list(page) {
      const rows = listPaid.all(pageSize + 1, (page - 1) * pageSize);
      return { jobs: rows.slice(0, pageSize).map(publicJob), nextPage: rows.length > pageSize ? page + 1 : null };
    },

    lookup(trackingId) {
      const row = findPaid.get(trackingId);
      return row ? publicJob(row) : null;
    },

    update(trackingId, command) {
      const milestone = commands.get(command);
      if (!milestone) return 'Use /progress followed by the tracking ID and search, 10, 20, 30, or tidying.';
      const row = findPaid.get(trackingId);
      if (!row) return 'No paid rental matches that tracking ID.';
      if (row.complete) return 'This rental is already complete.';
      if (milestone >= 2 && row.milestone === 0) return 'Mark the grounded search complete with /progress and search first.';
      if (!setMilestone.run(row.request_id, milestone).changes) {
        const current = publicJob(row);
        return `This rental is already at ${current.percent}%. Progress can only move forward.`;
      }
      const next = stages[milestone];
      return `Progress updated to ${next.percent}%. ${next.name}.`;
    }
  };
}
