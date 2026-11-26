import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createOwnerEmailDelivery, installOwnerEmailOutbox } from './owner-email.mjs';

test('structure a verified brief, sign it, and email it once even if the first response is lost', async () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`
      CREATE TABLE rentals (
        request_id TEXT PRIMARY KEY, tracking_id TEXT, brief_json TEXT, session_id TEXT,
        paid_at INTEGER, status TEXT, reference_image BLOB, reference_image_type TEXT
      )
    `);
    installOwnerEmailOutbox(database);
    const requestId = randomUUID();
    const trackingId = `UK-${randomUUID().toUpperCase()}`;
    const saved = {
      products_services: 'Tailor service', specific_detail: 'Silk dress\nSize M', amount: '1 dress',
      maximum_budget: 'SGD 150 total', location: 'Pasir Ris, Singapore', priority: 'quality',
      email: 'customer@example.com', whatsapp: '', telegram: '@fixture'
    };
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    database.prepare('INSERT INTO rentals VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(requestId, trackingId, JSON.stringify(saved), 'cs_fixture', 1_700_000_000, 'pending', image, 'image/png');
    assert.equal(database.prepare('SELECT COUNT(*) AS total FROM owner_email_outbox').get().total, 0);
    database.exec("UPDATE rentals SET status = 'paid'");
    database.exec("UPDATE rentals SET status = 'paid'");

    const properties = new Map();
    const sent = [];
    const context = {
      PropertiesService: { getScriptProperties: () => ({
        getProperty: key => properties.get(key),
        setProperty: (key, value) => properties.set(key, value)
      }) },
      MailApp: {
        getRemainingDailyQuota: () => 100,
        sendEmail: email => sent.push(email)
      },
      LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
      Utilities: {
        getUuid: randomUUID,
        Charset: { UTF_8: 'UTF-8' },
        computeHmacSha256Signature: (value, key) => [...createHmac('sha256', key).update(value).digest()],
        newBlob: (value, mimeType, name) => ({ value, mimeType, name }),
        base64Decode: value => Buffer.from(value, 'base64')
      },
      ContentService: {
        MimeType: { JSON: 'application/json' },
        createTextOutput: value => ({ setMimeType: () => value })
      }
    };
    const source = readFileSync(new URL('./owner-mail-bridge.gs', import.meta.url), 'utf8');
    const script = runInNewContext(source + '\n({ initializeOwnerMail, doPost })', context);
    script.initializeOwnerMail();

    const forged = script.doPost({ postData: { contents: JSON.stringify({ payload: '{}', signature: '0'.repeat(64) }) } });
    assert.equal(JSON.parse(forged).accepted, false);
    assert.equal(sent.length, 0);
    let deliveries = 0;
    const request = async (_url, options) => {
      const result = script.doPost({ postData: { contents: options.body } });
      if (++deliveries === 1) throw new Error('The response was lost after Google sent the email.');
      return new Response(result, { status: 200 });
    };
    const worker = createOwnerEmailDelivery({
      database,
      url: 'https://script.google.com/macros/s/fixture/exec',
      secret: properties.get('OWNER_MAIL_SECRET'),
      request,
      log: { info() {}, warn() {}, error() {} }
    });

    await worker.tick();
    assert.equal(sent.length, 1);
    assert.equal(database.prepare('SELECT delivered_at FROM owner_email_outbox').get().delivered_at, null);
    database.exec('UPDATE owner_email_outbox SET next_attempt_at = 0');
    await worker.tick();
    await worker.tick();
    assert.equal(sent.length, 1);
    assert.equal(deliveries, 2);
    assert.ok(database.prepare('SELECT delivered_at FROM owner_email_outbox').get().delivered_at);
    const email = sent[0];
    assert.equal(email.to, 'unemployedkittens@gmail.com');
    assert.equal(email.subject, `[Rent a Kitten] Paid rental ${trackingId}`);
    assert.match(email.body, /SEARCH BRIEF[\s\S]*CUSTOMER CONTACT/);
    assert.equal(email.attachments[0].name, 'rental-brief.v1.json');
    const brief = JSON.parse(email.attachments[0].value);
    assert.equal(brief.schema_version, 'rent-a-kitten.brief.v1');
    assert.equal(brief.tracking_id, trackingId);
    assert.deepEqual(brief.search_request, {
      product_or_service: 'Tailor service', requirements: 'Silk dress\nSize M', quantity: '1 dress',
      maximum_budget: 'SGD 150 total', location: 'Pasir Ris, Singapore', priority: 'quality',
      result_limit: 30, reference_image: { filename: 'reference-image.png', mime_type: 'image/png' }
    });
    assert.deepEqual(brief.customer, { email: 'customer@example.com', whatsapp: null, telegram: '@fixture' });
    assert.equal(email.attachments[1].name, 'reference-image.png');
    assert.deepEqual(email.attachments[1].value, image);
  } finally {
    database.close();
  }
});
