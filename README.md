# Unemployed Kittens

A responsive static landing page for an information marketplace, with a Rent a Kitten form, an AI search consultation offer, and contact links.

The live rental form sends the brief to the checkout backend on Railway. A copy with an empty checkout API URL runs in preview mode with sample payments and demo tracking IDs.

## Local development

No dependencies or build step. From this directory, run:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open the local server in your browser. The homepage is `index.html` and the rental form is `rent-a-kitten.html`. Images are in `assets/`.

## GitHub Pages

Push these files to the `main` branch. In the GitHub repository, open **Settings → Pages**, choose **Deploy from a branch**, and select **main / (root)**. Relative asset paths support both project sites and a future custom domain. No API keys or server are required.

The typography uses Google Fonts with local system fallbacks. All kitten images are served from this repository.

## Stripe checkout

The Node backend in `checkout/` saves rental briefs and optional reference images to a private SQLite database. It creates a one-time S$20 Checkout Session for cards and PayNow with the **UnemployedKittens** display name and confirms the rental only after Stripe sends a signed event for the matching paid session. The paid return page displays the tracking ID. Customer email and the progress page require separate integrations.

1. Deploy `checkout/` on a Node 24 HTTPS host with a persistent private volume. Run `npm ci` and `npm start` from that directory. Use `checkout/.env.example` as the environment variable reference. Set `RENTALS_DB_PATH` to a path on the private volume and `SITE_ORIGIN` to the website origin.
2. In a Stripe sandbox, configure a one-time SGD 20 rental price and a payment method configuration with PayNow enabled. Set `STRIPE_RENTAL_PRICE_ID` and `STRIPE_PAYMENT_METHOD_CONFIGURATION` to their IDs. Store `STRIPE_RESTRICTED_KEY`, with Checkout Sessions write access, in the host's secret store.
3. In Stripe Workbench, register `https://<checkout-host>/api/stripe/webhook` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, and `checkout.session.expired`. Store the webhook endpoint's signing secret as `STRIPE_WEBHOOK_SECRET`.
4. Set the `rental-checkout-api` meta tag in a staging copy of `rent-a-kitten.html` to the API's HTTPS origin. Run a full sandbox payment, check that the success page shows a tracking ID, and verify the paid rental in the private database. Repeat the configuration with the live price, restricted key, and webhook endpoint before setting the meta tag on the public website. An empty meta tag keeps the public form in preview mode.

Run `npm test` from `checkout/` to test the request and signed webhook flow locally. The `rentals` table stores the tracking ID, payment state, and brief in `brief_json` for owner review via the private database. Keep database files and backups outside the static site.

## USDC on Solana

Set `SOLANA_RECEIVING_ADDRESS` to the merchant's public Solana wallet address. The live API exposes the Solana option only when that address is configured. `SOLANA_RPC_URL` optionally overrides the HTTPS mainnet RPC endpoint. The quote uses the latest available SGD-to-USD reference rate from Frankfurter, with USDC priced at USD parity and rounded to two decimals. The saved quote keeps the same amount and Solana Pay reference on retry. The API confirms payment only after a finalized transaction credits the merchant's USDC token account with the exact quoted amount and matches the reference. Each transaction can be applied to one rental.

## Telegram rental alerts

Set `TELEGRAM_BOT_TOKEN` and a random `TELEGRAM_PAIRING_CODE` in the host's secret store. In a private chat with the bot, send `/start` followed by the pairing code. A confirmation message indicates the chat has been saved. The backend queues an alert when a Stripe or Solana rental transitions to paid and retries temporary delivery failures. Alerts include the tracking ID and payment provider. The queue and paired chat are stored in the private SQLite database so they survive deploys.

## Owner brief email

The backend queues an email to `unemployedkittens@gmail.com` when a rental transitions to paid. It uses an authenticated Google Apps Script web app for delivery. The email subject starts with `[Rent a Kitten] Paid rental` and includes the tracking ID. The email has a readable brief, a machine-readable `rental-brief.v1.json` attachment, and the reference image if one was provided.

1. Sign in to [Google Apps Script](https://script.google.com/home) as `unemployedkittens@gmail.com`. Create a project and paste the contents of `checkout/owner-mail-bridge.gs` into `Code.gs`. Save it, then run `initializeOwnerMail` and grant the mail permission.
2. Choose **Deploy → New deployment → Web app**. Use **Execute as Me** and **Who has access: Anyone**. The bridge checks a signature before it can send email. Copy the deployed URL ending in `/exec` into the Railway service as `OWNER_MAIL_BRIDGE_URL`.
3. In Apps Script, open **Project Settings → Script properties**, copy the generated `OWNER_MAIL_SECRET` directly to the Railway service under the same name, and seal it. Apply the Railway variables. New paid rentals remain queued until delivery is available.

### Brief format for grounded search

Use `tracking_id` to associate results with the order. Send only `search_request` to the search workflow. Contact details are in a separate `customer` object. The field `reference_image` is null when there is no upload, otherwise it identifies the accompanying attachment by filename and MIME type.

```json
{
  "product_or_service": "Brie cheese",
  "requirements": "Origin must be Australia",
  "quantity": "2 kg",
  "maximum_budget": "SGD 150 total",
  "location": "Pasir Ris, Singapore",
  "priority": "value",
  "result_limit": 30,
  "reference_image": null
}
```

The priority values are `value` (balance price and quality), `cheap` (prioritise price), and `quality` (prioritise quality or brand). Quantity, budget, and location retain the customer's wording, including units and currencies.
