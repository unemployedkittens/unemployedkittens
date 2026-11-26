import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/addresses';
import bs58 from 'bs58';
import { createRentalServer } from './server.mjs';
import { createSolanaPayments, usdcMint } from './solana.mjs';

test('honours a saved USDC quote and accepts one finalised transfer to the right rental', async context => {
  const siteOrigin = 'https://unemployedkittens.com';
  const recipient = bs58.encode(Buffer.alloc(32, 5));
  const signature = bs58.encode(Buffer.alloc(64, 7));
  const encoder = getAddressEncoder();
  const [tokenAccount] = await getProgramDerivedAddress({
    programAddress: address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
    seeds: [recipient, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', usdcMint]
      .map(key => encoder.encode(address(key)))
  });
  let tx;
  let rate = 0.75;
  const request = async (url, options) => {
    if (String(url).includes('frankfurter.dev')) {
      return Response.json({ base: 'SGD', quote: 'USD', rate, date: new Date().toISOString().slice(0, 10) });
    }
    const rpc = JSON.parse(options.body);
    assert.equal(rpc.params[1].commitment, 'finalized');
    return Response.json({ result: rpc.method === 'getSignaturesForAddress' ? [{ signature, err: null }] : tx });
  };

  const solana = createSolanaPayments({ recipient, request });
  const database = new DatabaseSync(':memory:');
  const server = createRentalServer({ stripe: {}, database, siteOrigin, liveMode: true, solana }).listen(0, '127.0.0.1');
  context.after(async () => {
    await new Promise(resolve => server.close(resolve));
    database.close();
  });
  await once(server, 'listening');
  const api = `http://127.0.0.1:${server.address().port}/api/rentals`;

  async function create(requestId, provider = 'solana') {
    const form = new FormData();
    for (const [key, value] of Object.entries({
      request_id: requestId, payment_provider: provider, products_services: 'Brie',
      specific_detail: 'Australian origin', amount: '2 kg', maximum_budget: 'SGD 100',
      location: 'Singapore', priority: 'value', email: 'example@example.com'
    })) {
      form.set(key, value);
    }
    return fetch(api, { method: 'POST', headers: { Origin: siteOrigin }, body: form });
  }

  async function verify(requestId, signatureInput = '') {
    return fetch(`${api}/solana/verify`, {
      method: 'POST', headers: { Origin: siteOrigin },
      body: new URLSearchParams({ request_id: requestId, signature: signatureInput })
    });
  }

  const id = randomUUID();
  assert.equal((await (await fetch(`${api}/options`)).json()).solana, true);
  const quote = await (await create(id)).json();
  assert.equal(quote.amount, '15.00');
  assert.match(quote.qr, /^data:image\/png;base64,/);
  const uri = new URL(quote.uri);
  assert.equal(uri.pathname, recipient);
  assert.equal(uri.searchParams.get('spl-token'), usdcMint);
  const reference = uri.searchParams.get('reference');
  rate = 0.72;
  assert.deepEqual(await (await create(id)).json(), quote);
  assert.equal((await create(id, 'stripe')).status, 409);
  assert.deepEqual(await (await verify(id)).json(), { status: 'pending' });

  tx = {
    transaction: {
      signatures: [signature],
      message: { accountKeys: [
        { pubkey: reference, signer: false, writable: false },
        { pubkey: 'wrong-token-account', signer: false, writable: true }
      ] }
    },
    meta: {
      err: null,
      preTokenBalances: [],
      postTokenBalances: [{ accountIndex: 1, owner: recipient, mint: usdcMint, uiTokenAmount: { amount: '15000000' } }]
    }
  };
  assert.deepEqual(await (await verify(id, signature)).json(), { status: 'pending' });
  const keys = tx.transaction.message.accountKeys;
  keys[1].pubkey = tokenAccount;
  tx.meta.postTokenBalances[0].uiTokenAmount.amount = '14999999';
  assert.deepEqual(await (await verify(id, signature)).json(), { status: 'pending' });
  tx.meta.postTokenBalances[0].uiTokenAmount.amount = '15000000';
  keys[0].writable = true;
  assert.deepEqual(await (await verify(id)).json(), { status: 'pending' });
  keys[0].writable = false;
  const paid = await (await verify(id, signature)).json();
  assert.equal(paid.status, 'paid');
  assert.match(paid.trackingId, /^UK-[A-F0-9-]{36}$/);
  assert.deepEqual(await (await fetch(`${api}/solana?request_id=${id}`)).json(), paid);
  assert.deepEqual(database.prepare('SELECT request_id FROM telegram_outbox').all().map(row => row.request_id), [id]);
  assert.deepEqual(database.prepare('SELECT request_id FROM owner_email_outbox').all().map(row => row.request_id), [id]);

  const otherId = randomUUID();
  const other = await (await create(otherId)).json();
  assert.deepEqual(await (await verify(otherId, signature)).json(), { status: 'pending' });
  keys[0].pubkey = new URL(other.uri).searchParams.get('reference');
  tx.meta.postTokenBalances[0].uiTokenAmount.amount = '14400000';
  assert.equal((await verify(otherId, signature)).status, 409);
});
