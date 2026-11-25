import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createTelegramAlerts, installTelegramOutbox } from './telegram.mjs';

test('deliver alerts only to the paired private chat and retry a temporary Telegram failure', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE rentals (request_id TEXT PRIMARY KEY, tracking_id TEXT, session_id TEXT, status TEXT)');
  database.exec("INSERT INTO rentals VALUES ('historical', 'UK-HISTORICAL', 'cs_old', 'paid')");
  installTelegramOutbox(database);
  database.exec("INSERT INTO rentals VALUES ('stripe', 'UK-STRIPE', 'cs_fixture', 'pending'), ('solana', 'UK-SOLANA', NULL, 'pending')");
  database.exec("UPDATE rentals SET status = 'paid' WHERE request_id IN ('stripe', 'solana')");
  database.exec("UPDATE rentals SET status = 'paid' WHERE request_id = 'stripe'");

  const attempts = [];
  const pairingCode = 'fixture-pairing-code';
  let updates = [
    { update_id: 7, message: { chat: { id: 12, type: 'private' }, text: '/start wrong-code' } },
    { update_id: 8, message: { chat: { id: 13, type: 'group' }, text: `/start ${pairingCode}` } }
  ];
  let shouldRetry = true;
  const request = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/getUpdates')) {
      return Response.json({ ok: true, result: updates });
    }
    assert.ok(url.endsWith('/sendMessage'));
    attempts.push(body);
    if (body.text.includes('UK-STRIPE') && shouldRetry) {
      shouldRetry = false;
      return Response.json({ ok: false, parameters: { retry_after: 99 } }, { status: 429 });
    }
    return Response.json({ ok: true, result: {} });
  };
  const settings = { database, token: '345:fixture', pairingCode, request, log: { info() {}, warn() {}, error() {} } };
  const worker = createTelegramAlerts(settings);

  await worker.tick();
  assert.equal(attempts.length, 0);
  updates = [{ update_id: 9, message: { chat: { id: 42, type: 'private' }, text: `/start ${pairingCode}` } }];
  await worker.tick();
  assert.match(attempts[0].text, /UnemployedKittens is connected/);

  await worker.tick();
  assert.match(attempts[1].text, /UK-STRIPE/);
  const failed = database.prepare("SELECT * FROM telegram_outbox WHERE request_id = 'stripe'").get();
  assert.equal(failed.delivered_at, null);
  assert.ok(failed.next_attempt_at > Math.floor(Date.now() / 1000) + 90);

  const restarted = createTelegramAlerts(settings);
  await restarted.tick();
  assert.match(attempts[2].text, /UK-SOLANA/);
  database.exec("UPDATE telegram_outbox SET next_attempt_at = 0 WHERE request_id = 'stripe'");
  await restarted.tick();
  assert.match(attempts[3].text, /UK-STRIPE/);
  await restarted.tick();
  assert.equal(attempts.length, 4);
  assert.ok(attempts.every(attempt => attempt.chat_id === 42 && !attempt.text.includes('UK-HISTORICAL')));
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM telegram_outbox WHERE delivered_at IS NOT NULL').get().count, 2);
  database.close();
});
