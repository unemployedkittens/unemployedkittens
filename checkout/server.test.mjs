import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import Stripe from 'stripe';
import { createRentalServer } from './server.mjs';

const siteOrigin = 'https://unemployedkittens.com';
const webhookSecret = 'fixture-webhook-secret';
const stripe = new Stripe('fixture-api-key');

test('stores the brief before checkout and confirms it only after an authenticated payment', async context => {
  const database = new DatabaseSync(':memory:');
  const requestId = randomUUID();
  const session = {
    id: 'cs_test_RentalMock123',
    livemode: false,
    currency: 'sgd',
    amount_total: 2000,
    mode: 'payment',
    url: 'https://checkout.stripe.com/c/fixture',
    expires_at: Math.floor(Date.now() / 1000) + 1200,
    payment_method_types: ['paynow'],
    metadata: { service: 'rent_a_kitten', checkout_source: 'rental_form' },
    client_reference_id: requestId,
    status: 'complete',
    payment_status: 'paid'
  };
  let sessionsCreated = 0;
  const stripeFixture = {
    webhooks: stripe.webhooks,
    checkout: { sessions: { create: async (parameters, options) => {
      sessionsCreated += 1;
      assert.equal(database.prepare('SELECT status FROM rentals WHERE request_id = ?').get(requestId).status, 'pending');
      assert.deepEqual(parameters.branding_settings, { display_name: 'UnemployedKittens' });
      assert.deepEqual(parameters.line_items, [{ price: 'price_fixture', quantity: 1 }]);
      assert.equal(parameters.payment_method_configuration, 'pmc_fixture');
      assert.equal(parameters.automatic_tax.enabled, false);
      assert.equal(parameters.adaptive_pricing.enabled, false);
      assert.equal(parameters.client_reference_id, requestId);
      assert.equal(options.idempotencyKey, `rent-a-kitten:${requestId}`);
      return session;
    } } }
  };

  const server = createRentalServer({
    stripe: stripeFixture, database, siteOrigin, webhookSecret,
    paymentConfiguration: 'pmc_fixture', priceId: 'price_fixture', liveMode: false
  }).listen(0, '127.0.0.1');
  context.after(async () => {
    await new Promise(resolve => server.close(resolve));
    database.close();
  });
  await once(server, 'listening');
  const api = `http://127.0.0.1:${server.address().port}`;
  const statusUrl = `${api}/api/rentals/status?session_id=${session.id}`;
  assert.deepEqual(await (await fetch(`${api}/health`)).json(), { ready: true, livemode: false });
  const brief = {
    request_id: requestId, products_services: 'Brie', specific_detail: 'Australian origin',
    amount: '2 kg', maximum_budget: 'SGD 100', location: 'Singapore',
    priority: 'value', email: 'example@example.com'
  };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+y2ZkAAAAASUVORK5CYII=', 'base64');
  async function submit(fields, image = new File([png], 'reference.png', { type: 'image/png' }), origin = siteOrigin) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      form.set(key, value);
    }
    form.set('reference_image', image);
    return fetch(`${api}/api/rentals`, { method: 'POST', headers: { Origin: origin }, body: form });
  }

  function webhook(type, values = {}, signed = true) {
    const payload = JSON.stringify({
      type, livemode: false, created: Math.floor(Date.now() / 1000),
      data: { object: { ...session, ...values } }
    });
    const header = signed ? stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret }) : 'invalid';
    return fetch(`${api}/api/stripe/webhook`, {
      method: 'POST', headers: { 'Stripe-Signature': header }, body: payload
    });
  }

  assert.equal((await submit(brief, undefined, 'https://example.org')).status, 403);
  assert.equal((await submit(brief, new File(['invalid'], 'reference.png', { type: 'image/png' }))).status, 400);
  assert.equal((await submit({ ...brief, email: '' })).status, 400);

  const checkout = await submit(brief);
  assert.equal(checkout.status, 200);
  assert.equal(checkout.headers.get('access-control-allow-origin'), siteOrigin);
  assert.deepEqual(await checkout.json(), { url: session.url });
  assert.equal((await submit(brief)).status, 200);
  assert.equal(sessionsCreated, 1);
  assert.equal((await submit({ ...brief, amount: '3 kg' })).status, 409);
  assert.deepEqual(await (await fetch(statusUrl)).json(), { status: 'pending' });
  assert.equal((await webhook('checkout.session.completed', {}, false)).status, 400);
  assert.equal((await webhook('checkout.session.completed', { payment_status: 'unpaid' })).status, 200);
  assert.equal((await webhook('checkout.session.completed', { amount_total: 100 })).status, 200);
  assert.equal((await webhook('checkout.session.completed', { metadata: { service: 'rent_a_kitten' } })).status, 200);
  assert.deepEqual(await (await fetch(statusUrl)).json(), { status: 'pending' });
  assert.equal((await webhook('checkout.session.completed')).status, 200);

  const paid = await (await fetch(statusUrl)).json();
  assert.equal(paid.status, 'paid');
  assert.match(paid.trackingId, /^UK-[A-F0-9-]{36}$/);
  assert.equal((await webhook('checkout.session.async_payment_succeeded')).status, 200);
  assert.equal((await webhook('checkout.session.expired')).status, 200);
  assert.deepEqual(await (await fetch(statusUrl)).json(), paid);
  assert.equal((await submit(brief)).status, 409);

  const saved = database.prepare('SELECT brief_json, reference_image FROM rentals WHERE request_id = ?').get(requestId);
  assert.equal(JSON.parse(saved.brief_json).email, brief.email);
  assert.deepEqual(Buffer.from(saved.reference_image), png);
});
