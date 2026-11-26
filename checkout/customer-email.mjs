export function installCustomerEmailOutbox(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS rental_completion (
      request_id TEXT PRIMARY KEY REFERENCES rentals(request_id),
      completed_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS customer_email_outbox (
      delivery_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES rentals(request_id),
      kind TEXT NOT NULL CHECK (kind IN ('customer_confirmation', 'customer_complete')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER NOT NULL DEFAULT 0,
      delivered_at INTEGER,
      UNIQUE (request_id, kind)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS customer_email_pending ON customer_email_outbox (next_attempt_at)
      WHERE delivered_at IS NULL;

    CREATE TRIGGER IF NOT EXISTS customer_email_after_payment
    AFTER UPDATE OF status ON rentals
    WHEN OLD.status <> 'paid' AND NEW.status = 'paid'
    BEGIN
      INSERT OR IGNORE INTO customer_email_outbox (delivery_id, request_id, kind)
      VALUES (lower(hex(randomblob(16))), NEW.request_id, 'customer_confirmation');
    END;

    CREATE TRIGGER IF NOT EXISTS customer_email_after_completion
    AFTER INSERT ON rental_completion
    BEGIN
      INSERT OR IGNORE INTO customer_email_outbox (delivery_id, request_id, kind)
      VALUES (lower(hex(randomblob(16))), NEW.request_id, 'customer_complete');
    END;
  `);
}

export function createRentalCompletion(database) {
  const findPaid = database.prepare("SELECT request_id FROM rentals WHERE tracking_id = ? AND status = 'paid'");
  const complete = database.prepare(`
    INSERT INTO rental_completion (request_id, completed_at) VALUES (?, ?)
    ON CONFLICT(request_id) DO NOTHING
  `);
  return function completeRental(trackingId) {
    const rental = findPaid.get(trackingId);
    if (!rental) return 'No paid rental matches that tracking ID.';
    if (!complete.run(rental.request_id, Math.floor(Date.now() / 1000)).changes) {
      return 'This rental is already marked complete.';
    }
    return 'Rental marked complete. The customer email is queued.';
  };
}

export function createCustomerEmailDelivery({ database, send, log = console }) {
  const claim = database.prepare(`
    UPDATE customer_email_outbox SET lease_until = ?, attempts = attempts + 1
    WHERE delivery_id = (
      SELECT job.delivery_id FROM customer_email_outbox AS job
      WHERE job.delivered_at IS NULL AND job.next_attempt_at <= ? AND job.lease_until <= ?
      AND (job.kind = 'customer_confirmation' OR NOT EXISTS (
        SELECT 1 FROM customer_email_outbox AS confirmation
        WHERE confirmation.request_id = job.request_id AND confirmation.kind = 'customer_confirmation'
        AND confirmation.delivered_at IS NULL
      ))
      ORDER BY job.next_attempt_at, job.rowid LIMIT 1
    )
    RETURNING delivery_id, request_id, kind, attempts
  `);
  const getRental = database.prepare("SELECT tracking_id, brief_json FROM rentals WHERE request_id = ? AND status = 'paid'");
  const delivered = database.prepare('UPDATE customer_email_outbox SET delivered_at = ?, lease_until = 0 WHERE delivery_id = ?');
  const retry = database.prepare('UPDATE customer_email_outbox SET next_attempt_at = ?, lease_until = 0 WHERE delivery_id = ?');
  let active = false;
  let bridgeReady = false;
  let nextBridgeCheck = 0;

  async function tick() {
    if (active) return;
    active = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      if (!bridgeReady) {
        if (now < nextBridgeCheck) return;
        nextBridgeCheck = now + 60;
        const { result } = await send({ kind: 'capabilities' });
        bridgeReady = result?.customer_email === true;
        if (!bridgeReady) return;
        log.info('Customer email bridge verified.');
      }

      const job = claim.get(now + 90, now, now);
      if (!job) return;
      try {
        const rental = getRental.get(job.request_id);
        const { failure } = await send({
          kind: job.kind,
          delivery_id: job.delivery_id,
          tracking_id: rental.tracking_id,
          recipient: JSON.parse(rental.brief_json).email
        });
        if (failure) throw new Error('The customer email was not accepted.');
        delivered.run(Math.floor(Date.now() / 1000), job.delivery_id);
        log.info(job.kind === 'customer_confirmation' ? 'Customer confirmation emailed.' : 'Customer completion emailed.');
      } catch {
        const delay = Math.min(3600, 15 * 2 ** Math.min(job.attempts, 8));
        retry.run(Math.floor(Date.now() / 1000) + delay, job.delivery_id);
        log.warn('Customer rental email will retry.');
      }
    } catch {
      log.error('Customer email worker could not update its queue.');
    } finally {
      active = false;
    }
  }

  return {
    tick,
    start() {
      const timer = setInterval(tick, 10_000);
      timer.unref();
      void tick();
    }
  };
}
