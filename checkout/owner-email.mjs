import { createHmac } from 'node:crypto';

const attachmentNames = {
  'image/jpeg': 'reference-image.jpg',
  'image/png': 'reference-image.png',
  'image/webp': 'reference-image.webp'
};

export function installOwnerEmailOutbox(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS owner_email_outbox (
      request_id TEXT PRIMARY KEY REFERENCES rentals(request_id),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER NOT NULL DEFAULT 0,
      delivered_at INTEGER
    ) STRICT;

    CREATE INDEX IF NOT EXISTS owner_email_outbox_pending ON owner_email_outbox (next_attempt_at)
      WHERE delivered_at IS NULL;

    CREATE TABLE IF NOT EXISTS owner_email_samples (
      delivery_id TEXT PRIMARY KEY,
      delivered_at INTEGER NOT NULL
    ) STRICT;

    CREATE TRIGGER IF NOT EXISTS owner_email_after_payment
    AFTER UPDATE OF status ON rentals
    WHEN OLD.status <> 'paid' AND NEW.status = 'paid'
    BEGIN
      INSERT OR IGNORE INTO owner_email_outbox (request_id) VALUES (NEW.request_id);
    END;
  `);
}

export function buildOwnerBrief(rental) {
  const saved = JSON.parse(rental.brief_json);
  const imageName = rental.reference_image && attachmentNames[rental.reference_image_type];
  return {
    schema_version: 'rent-a-kitten.brief.v1',
    tracking_id: rental.tracking_id,
    payment: {
      provider: rental.session_id ? 'stripe' : 'solana',
      verified_at: new Date(rental.paid_at * 1000).toISOString()
    },
    search_request: {
      product_or_service: saved.products_services,
      requirements: saved.specific_detail,
      quantity: saved.amount,
      maximum_budget: saved.maximum_budget,
      location: saved.location,
      priority: saved.priority,
      result_limit: 30,
      reference_image: imageName ? { filename: imageName, mime_type: rental.reference_image_type } : null
    },
    customer: {
      email: saved.email,
      whatsapp: saved.whatsapp || null,
      telegram: saved.telegram || null
    }
  };
}

export function createOwnerEmailDelivery({ database, url, secret, request = fetch, log = console }) {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url) ||
      !/^[a-f0-9]{64}$/i.test(secret)) {
    throw new Error('Invalid Gmail bridge URL or signing secret.');
  }
  const claim = database.prepare(`
    UPDATE owner_email_outbox SET lease_until = ?, attempts = attempts + 1
    WHERE request_id = (
      SELECT request_id FROM owner_email_outbox
      WHERE delivered_at IS NULL AND next_attempt_at <= ? AND lease_until <= ?
      ORDER BY next_attempt_at, rowid LIMIT 1
    )
    RETURNING request_id, attempts
  `);
  const getRental = database.prepare(`
    SELECT tracking_id, brief_json, session_id, paid_at, reference_image, reference_image_type
    FROM rentals WHERE request_id = ? AND status = 'paid'
  `);
  const delivered = database.prepare('UPDATE owner_email_outbox SET delivered_at = ?, lease_until = 0 WHERE request_id = ?');
  const retry = database.prepare('UPDATE owner_email_outbox SET next_attempt_at = ?, lease_until = 0 WHERE request_id = ?');
  let active = false;

  async function sendBrief(deliveryId, brief, image = null) {
    const payload = JSON.stringify({
      delivery_id: deliveryId,
      issued_at: Math.floor(Date.now() / 1000),
      brief,
      reference_image: image ? Buffer.from(image).toString('base64') : null
    });
    const signature = createHmac('sha256', secret).update(payload).digest('hex');
    let response;
    try {
      response = await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload, signature }),
        signal: AbortSignal.timeout(35_000)
      });
    } catch {
      return 'network request failed';
    }
    if (!response.ok) return `bridge returned HTTP ${response.status}`;
    const result = await response.json().catch(() => null);
    if (!result) return 'bridge response was not JSON';
    if (result.accepted !== true) return 'bridge did not accept the brief';
    return null;
  }

  async function sendSample(deliveryId) {
    if (!/^[a-f0-9-]{36}$/.test(deliveryId) ||
        database.prepare('SELECT 1 FROM owner_email_samples WHERE delivery_id = ?').get(deliveryId)) return;

    const now = Math.floor(Date.now() / 1000);
    const brief = buildOwnerBrief({
      tracking_id: `UK-${deliveryId.toUpperCase()}`,
      paid_at: now,
      brief_json: JSON.stringify({
        products_services: '[TEST] Brie cheese',
        specific_detail: 'Sample brief to verify email delivery. No rental or payment was created.',
        amount: '2 kg', maximum_budget: 'SGD 150 total', location: 'Singapore',
        priority: 'value', email: 'customer@example.com'
      })
    });
    brief.payment.provider = 'test (no payment)';
    brief.sample = true;
    const failure = await sendBrief(deliveryId, brief);
    if (failure) {
      log.warn(`Owner rental email sample failed: ${failure}.`);
      return;
    }
    database.prepare('INSERT OR IGNORE INTO owner_email_samples VALUES (?, ?)').run(deliveryId, now);
    log.info('Owner rental email sample delivered.');
  }

  async function tick() {
    if (active) return;
    active = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      const queued = claim.get(now + 90, now, now);
      if (!queued) return;
      try {
        const rental = getRental.get(queued.request_id);
        const brief = buildOwnerBrief(rental);
        const failure = await sendBrief(queued.request_id, brief,
          brief.search_request.reference_image ? rental.reference_image : null);
        if (failure) {
          throw new Error('The Gmail bridge did not accept the brief.');
        }
        delivered.run(Math.floor(Date.now() / 1000), queued.request_id);
        log.info('Owner rental brief emailed.');
      } catch {
        const delay = Math.min(3600, 15 * 2 ** Math.min(queued.attempts, 8));
        retry.run(Math.floor(Date.now() / 1000) + delay, queued.request_id);
        log.warn('Owner rental brief email will retry.');
      }
    } catch {
      log.error('Rental email worker could not update its queue.');
    } finally {
      active = false;
    }
  }

  return {
    tick,
    start(sampleId) {
      const timer = setInterval(tick, 10_000);
      timer.unref();
      void tick();
      if (sampleId) {
        void sendSample(sampleId).catch(() => log.error('Owner rental email sample could not be prepared.'));
      }
    }
  };
}
