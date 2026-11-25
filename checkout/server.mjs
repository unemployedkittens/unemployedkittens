import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import Stripe from 'stripe';
import { createSolanaPayments } from './solana.mjs';

const rentalFee = 2000;
const checkoutCurrency = 'sgd';
const checkoutPage = '/rent-a-kitten.html';
const integrationIdentifier = 'rent-a-kitten-qrvxnmda';
const maxImageBytes = 5_000_000;
const stripeCheckoutMethods = new Set(['paynow', 'card', 'link']);
const rentalIdPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const paymentEvents = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired'
]);

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readBody(request, limit) {
  if (Number(request.headers['content-length']) > limit) {
    throw new RequestError(413, 'The submission is too large.');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) {
      request.resume();
      throw new RequestError(413, 'The submission is too large.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function field(form, name, max, required = true) {
  const value = form.get(name) ?? '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new RequestError(400, 'Check the required fields and their length limits.');
  }
  return value.trim();
}

async function parseRental(request) {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.startsWith('multipart/form-data;')) {
    throw new RequestError(415, 'Send the rental form as multipart form data.');
  }

  const body = await readBody(request, maxImageBytes + 32_768);
  const form = await new Response(body, { headers: { 'Content-Type': contentType } }).formData().catch(() => {
    throw new RequestError(400, 'The rental form could not be read.');
  });

  const requestId = field(form, 'request_id', 36);
  const provider = field(form, 'payment_provider', 8, false) || 'stripe';
  const brief = {
    products_services: field(form, 'products_services', 120),
    specific_detail: field(form, 'specific_detail', 800),
    amount: field(form, 'amount', 100),
    maximum_budget: field(form, 'maximum_budget', 80),
    location: field(form, 'location', 140),
    priority: field(form, 'priority', 7),
    email: field(form, 'email', 254),
    whatsapp: field(form, 'whatsapp', 40, false),
    telegram: field(form, 'telegram', 80, false)
  };

  if (!rentalIdPattern.test(requestId) || !['stripe', 'solana'].includes(provider) ||
      !['value', 'cheap', 'quality'].includes(brief.priority) ||
      !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*$/.test(brief.email)) {
    throw new RequestError(400, 'Check your email and research priorities, then try again.');
  }

  const image = form.get('reference_image');
  let imageBytes = null;
  let imageType = null;
  if (image instanceof File && image.size) {
    if (image.size > maxImageBytes) {
      throw new RequestError(400, 'The reference image must be 5 MB or smaller.');
    }
    imageBytes = Buffer.from(await image.arrayBuffer());
    const jpeg = imageBytes[0] === 0xff && imageBytes[1] === 0xd8 && imageBytes[2] === 0xff;
    const png = imageBytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    const webp = imageBytes.subarray(0, 4).toString() === 'RIFF' && imageBytes.subarray(8, 12).toString() === 'WEBP';
    imageType = jpeg ? 'image/jpeg' : png ? 'image/png' : webp ? 'image/webp' : null;
    if (!imageType || image.type !== imageType) {
      throw new RequestError(400, 'Choose a JPG, PNG, or WebP reference image.');
    }
  }

  const briefJson = JSON.stringify(brief);
  const fingerprint = createHash('sha256').update(briefJson).update(imageBytes ?? '')
    .update(provider === 'solana' ? ':solana' : '').digest('hex');
  return { requestId, provider, brief, briefJson, fingerprint, imageBytes, imageType };
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

export function createRentalServer({ stripe, database, siteOrigin, webhookSecret, paymentConfiguration, priceId, liveMode, solana }) {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS rentals (
      request_id TEXT PRIMARY KEY,
      tracking_id TEXT NOT NULL UNIQUE,
      fingerprint TEXT NOT NULL,
      brief_json TEXT NOT NULL,
      reference_image BLOB,
      reference_image_type TEXT,
      created_at INTEGER NOT NULL,
      session_id TEXT UNIQUE,
      checkout_url TEXT,
      session_expires_at INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'expired')),
      paid_at INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS solana_quotes (
      request_id TEXT PRIMARY KEY REFERENCES rentals(request_id),
      reference TEXT NOT NULL UNIQUE,
      recipient TEXT NOT NULL,
      usdc_atoms INTEGER NOT NULL CHECK (usdc_atoms > 0),
      signature TEXT UNIQUE
    ) STRICT;
  `);

  const insertRental = database.prepare(`
    INSERT INTO rentals (request_id, tracking_id, fingerprint, brief_json, reference_image, reference_image_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(request_id) DO NOTHING
  `);
  const getRental = database.prepare(`
    SELECT tracking_id, fingerprint, created_at, session_id, checkout_url, session_expires_at, status
    FROM rentals WHERE request_id = ?
  `);
  const setSession = database.prepare(`
    UPDATE rentals SET session_id = ?, checkout_url = ?, session_expires_at = ?
    WHERE request_id = ? AND (session_id IS NULL OR session_id = ?)
  `);
  const findBySession = database.prepare('SELECT status, tracking_id FROM rentals WHERE session_id = ?');
  const markPaid = database.prepare(`
    UPDATE rentals SET session_id = ?, status = 'paid', paid_at = ?
    WHERE request_id = ? AND (session_id IS NULL OR session_id = ?) AND status <> 'paid'
  `);
  const markUnpaid = database.prepare(`
    UPDATE rentals SET session_id = ?, status = ?
    WHERE request_id = ? AND (session_id IS NULL OR session_id = ?) AND status = 'pending'
  `);
  const getSolanaQuote = database.prepare(`
    SELECT solana_quotes.*, rentals.status, rentals.tracking_id
    FROM solana_quotes JOIN rentals USING (request_id) WHERE request_id = ?
  `);
  const saveSolanaQuote = database.prepare(`
    INSERT INTO solana_quotes (request_id, reference, recipient, usdc_atoms) VALUES (?, ?, ?, ?)
    ON CONFLICT(request_id) DO NOTHING
  `);
  const setSolanaSignature = database.prepare(`
    UPDATE solana_quotes SET signature = ? WHERE request_id = ? AND signature IS NULL
    AND NOT EXISTS (SELECT 1 FROM solana_quotes WHERE signature = ?)
  `);
  const markSolanaPaid = database.prepare(`
    UPDATE rentals SET status = 'paid', paid_at = ? WHERE request_id = ? AND status = 'pending' AND session_id IS NULL
  `);

  async function solanaQuoteResponse(response, quote) {
    if (quote.status === 'paid') {
      return json(response, 200, { status: 'paid', trackingId: quote.tracking_id });
    }
    json(response, 200, { status: 'pending', ...(await solana.instructions(quote)) });
  }

  function findSolanaQuote(reference) {
    if (!rentalIdPattern.test(reference ?? '')) {
      throw new RequestError(400, 'Invalid Solana rental reference.');
    }
    const quote = getSolanaQuote.get(reference);
    if (!quote) throw new RequestError(404, 'Solana rental reference not found.');
    return quote;
  }

  async function verifySolana(request, response) {
    const params = new URLSearchParams((await readBody(request, 1024)).toString());
    const quote = findSolanaQuote(params.get('request_id'));
    if (quote.status === 'paid') {
      return json(response, 200, { status: 'paid', trackingId: quote.tracking_id });
    }
    const signatureInput = params.get('signature')?.trim();
    if (signatureInput && !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signatureInput)) {
      throw new RequestError(400, 'Enter a valid Solana transaction signature.');
    }

    const signature = await solana.findPayment(quote, signatureInput);
    if (!signature) return json(response, 200, { status: 'pending' });

    database.exec('BEGIN IMMEDIATE');
    try {
      const update = setSolanaSignature.run(signature, quote.request_id, signature);
      if (update.changes && markSolanaPaid.run(Math.floor(Date.now() / 1000), quote.request_id).changes !== 1) {
        throw new Error('Solana payment could not be attached to a pending rental.');
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }

    const confirmed = getSolanaQuote.get(quote.request_id);
    if (confirmed.status !== 'paid') {
      throw new RequestError(409, 'This transaction was already applied to another rental.');
    }
    json(response, 200, { status: 'paid', trackingId: confirmed.tracking_id });
  }

  async function startCheckout(request, response) {
    const rental = await parseRental(request);
    if (rental.provider === 'solana' && !solana) {
      throw new RequestError(503, 'Solana checkout is unavailable. You can still pay through Stripe.');
    }
    const now = Math.floor(Date.now() / 1000);
    insertRental.run(
      rental.requestId, `UK-${randomUUID().toUpperCase()}`, rental.fingerprint,
      rental.briefJson, rental.imageBytes, rental.imageType, now
    );
    const order = getRental.get(rental.requestId);
    if (order.fingerprint !== rental.fingerprint) {
      throw new RequestError(409, 'This rental reference is already attached to a different brief.');
    }
    if (rental.provider === 'solana') {
      if (!getSolanaQuote.get(rental.requestId)) {
        const quote = await solana.createQuote(rentalFee);
        saveSolanaQuote.run(rental.requestId, quote.reference, quote.recipient, quote.usdc_atoms);
      }
      const quote = getSolanaQuote.get(rental.requestId);
      return await solanaQuoteResponse(response, quote);
    }
    if (order.status !== 'pending' ||
        (order.session_expires_at && order.session_expires_at <= now) ||
        (!order.session_id && order.created_at + 23 * 60 * 60 <= now)) {
      throw new RequestError(409, 'This checkout has closed. Check your payment before starting a new rental.');
    }
    if (order.checkout_url) {
      return json(response, 200, { url: order.checkout_url });
    }

    const page = new URL(checkoutPage, siteOrigin).href;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      integration_identifier: integrationIdentifier,
      client_reference_id: rental.requestId,
      customer_email: rental.brief.email,
      payment_method_configuration: paymentConfiguration,
      excluded_payment_method_types: ['alipay'],
      adaptive_pricing: { enabled: false },
      automatic_tax: { enabled: false },
      branding_settings: { display_name: 'UnemployedKittens' },
      metadata: { service: 'rent_a_kitten', checkout_source: 'rental_form' },
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${page}?checkout=return&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${page}?checkout=cancel`
    }, { idempotencyKey: `rent-a-kitten:${rental.requestId}` });

    if (!session.url?.startsWith('https://checkout.stripe.com/') ||
        session.livemode !== liveMode || session.currency !== checkoutCurrency || session.amount_total !== rentalFee ||
        !session.payment_method_types?.some(method => method === 'paynow' || method === 'card') ||
        session.payment_method_types.some(method => !stripeCheckoutMethods.has(method))) {
      throw new RequestError(503, 'Stripe checkout is unavailable. Please try again later.');
    }

    const updates = setSession.run(session.id, session.url, session.expires_at, rental.requestId, session.id);
    if (updates.changes !== 1) {
      throw new RequestError(409, 'This request is already linked to a different checkout.');
    }
    json(response, 200, { url: session.url });
  }

  async function receiveWebhook(request, response) {
    const payload = await readBody(request, 262_144);
    let event;
    try {
      event = stripe.webhooks.constructEvent(payload, request.headers['stripe-signature'], webhookSecret);
    } catch {
      throw new RequestError(400, 'Invalid Stripe webhook signature.');
    }

    const session = event.data.object;
    if (paymentEvents.has(event.type) &&
        event.livemode === liveMode && session.livemode === liveMode &&
        session.metadata?.service === 'rent_a_kitten' && session.metadata.checkout_source === 'rental_form' &&
        session.mode === 'payment' && session.currency === checkoutCurrency &&
        session.amount_total === rentalFee && session.client_reference_id) {
      if ((event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') &&
          session.status === 'complete' && session.payment_status === 'paid') {
        markPaid.run(session.id, event.created, session.client_reference_id, session.id);
      } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
        const status = event.type === 'checkout.session.expired' ? 'expired' : 'failed';
        markUnpaid.run(session.id, status, session.client_reference_id, session.id);
      }
    }
    json(response, 200, { received: true });
  }

  return createServer(async (request, response) => {
    try {
      const route = new URL(request.url, siteOrigin);
      if (route.pathname === '/health' && request.method === 'GET') {
        return json(response, 200, { ready: true, livemode: liveMode });
      }
      if (route.pathname === '/api/stripe/webhook' && request.method === 'POST') {
        return await receiveWebhook(request, response);
      }

      const origin = request.headers.origin;
      if (origin && origin !== siteOrigin) {
        throw new RequestError(403, 'This site cannot access rental checkout.');
      }
      response.setHeader('Vary', 'Origin');
      if (origin === siteOrigin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
      }
      if (route.pathname === '/api/rentals' && request.method === 'POST' && origin === siteOrigin) {
        return await startCheckout(request, response);
      }
      if (route.pathname === '/api/rentals/options' && request.method === 'GET') {
        return json(response, 200, { solana: Boolean(solana) });
      }
      if (solana && route.pathname === '/api/rentals/solana' && request.method === 'GET') {
        return await solanaQuoteResponse(response, findSolanaQuote(route.searchParams.get('request_id')));
      }
      if (solana && route.pathname === '/api/rentals/solana/verify' && request.method === 'POST' && origin === siteOrigin) {
        return await verifySolana(request, response);
      }
      if (route.pathname === '/api/rentals/status' && request.method === 'GET') {
        const sessionId = route.searchParams.get('session_id') ?? '';
        if (!/^cs_(test|live)_[A-Za-z0-9]{8,120}$/.test(sessionId)) {
          throw new RequestError(400, 'Invalid checkout reference.');
        }
        const order = findBySession.get(sessionId);
        if (!order) {
          throw new RequestError(404, 'Checkout reference not found.');
        }
        return json(response, 200, {
          status: order.status,
          ...(order.status === 'paid' && { trackingId: order.tracking_id })
        });
      }
      json(response, 404, { error: 'Endpoint not found.' });
    } catch (error) {
      if (error instanceof RequestError) {
        return json(response, error.status, { error: error.message });
      }
      if (error.type !== 'StripeIdempotencyError') {
        console.error('Rental checkout failed', error.type ?? error.code ?? error.name);
      }
      json(response, 503, { error: 'Checkout is temporarily unavailable. Retry to resume the same rental.' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {
    STRIPE_RESTRICTED_KEY: key,
    STRIPE_WEBHOOK_SECRET: webhookSecret,
    STRIPE_PAYMENT_METHOD_CONFIGURATION: paymentConfiguration,
    STRIPE_RENTAL_PRICE_ID: priceId,
    SOLANA_RECEIVING_ADDRESS: solanaRecipient,
    SOLANA_RPC_URL: solanaRpcUrl,
    SITE_ORIGIN: configuredOrigin = 'https://unemployedkittens.com',
    RENTALS_DB_PATH: databasePath = './data/rentals.sqlite',
    PORT = 8787
  } = process.env;

  const configured = /^rk_(?:live|test)_/.test(key ?? '') && webhookSecret?.startsWith('whsec_') &&
    paymentConfiguration?.startsWith('pmc_') && priceId?.startsWith('price_');
  if (!configured) {
    createServer((request, response) => {
      if (request.url === '/health' && request.method === 'GET') {
        return json(response, 200, { ready: false });
      }
      json(response, 503, { error: 'Rental checkout is being set up.' });
    }).listen(Number(PORT), () => console.log('Rental checkout awaiting Stripe configuration.'));
  } else {
    const siteOrigin = new URL(configuredOrigin).origin;
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    const previousUmask = process.umask(0o077);
    const database = new DatabaseSync(databasePath);
    process.umask(previousUmask);
    const stripe = new Stripe(key, {
      apiVersion: '2026-11-18.endive',
      timeout: 10_000,
      maxNetworkRetries: 2
    });

    const liveMode = key.startsWith('rk_live_');
    const solana = liveMode && solanaRecipient ? createSolanaPayments({ recipient: solanaRecipient, rpcUrl: solanaRpcUrl }) : undefined;
    createRentalServer({
      stripe, database, siteOrigin, webhookSecret, paymentConfiguration, priceId, liveMode, solana
    }).listen(Number(PORT), () => console.log('Rental checkout server listening.'));
  }
}
