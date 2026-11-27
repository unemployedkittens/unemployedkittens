import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createRentalCompletion, installCustomerEmailOutbox } from './customer-email.mjs';
import { createRentalProgress } from './progress.mjs';

test('track a paid job through all milestones and expose only anonymous progress', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('CREATE TABLE rentals (request_id TEXT PRIMARY KEY, tracking_id TEXT UNIQUE, status TEXT, paid_at INTEGER, brief_json TEXT)');
    installCustomerEmailOutbox(database);
    const progress = createRentalProgress(database);
    const complete = createRentalCompletion(database);
    const insert = database.prepare('INSERT INTO rentals VALUES (?, ?, ?, ?, ?)');
    const requestId = randomUUID();
    const trackingId = `UK-${randomUUID().toUpperCase()}`;
    insert.run(requestId, trackingId, 'pending', null, '{"email":"private@example.com"}');
    assert.equal(progress.lookup(trackingId), null);
    assert.match(progress.update(trackingId, 'search'), /No paid rental/);

    database.prepare("UPDATE rentals SET status = 'paid', paid_at = 100 WHERE request_id = ?").run(requestId);
    const first = progress.lookup(trackingId);
    assert.equal(first.percent, 20);
    assert.match(progress.update(trackingId, '10'), /Mark the grounded search complete/);
    for (const [command, percent] of [['search', 40], ['10', 50], ['20', 60], ['30', 70], ['tidying', 85]]) {
      assert.match(progress.update(trackingId, command), new RegExp(String(percent)));
      assert.equal(progress.lookup(trackingId).percent, percent);
      assert.equal(progress.lookup(trackingId).job, first.job);
    }
    assert.match(progress.update(trackingId, '20'), /only move forward/);
    assert.match(complete(trackingId), /customer email is queued/);
    assert.equal(progress.lookup(trackingId).percent, 100);
    assert.match(progress.update(trackingId, 'tidying'), /already complete/);

    for (let i = 0; i < 24; i++) {
      insert.run(randomUUID(), `UK-${randomUUID().toUpperCase()}`, 'paid', i, '{"email":"private@example.com"}');
    }
    const page = progress.list(1);
    assert.equal(page.jobs.length, 24);
    assert.equal(page.nextPage, 2);
    assert.equal(progress.list(2).jobs.length, 1);
    assert.equal(progress.list(2).nextPage, null);
    for (const privateValue of [requestId, trackingId, 'private@example.com']) {
      assert.ok(!JSON.stringify(page).includes(privateValue));
    }
  } finally {
    database.close();
  }
});
