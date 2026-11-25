# Unemployed Kittens

A responsive static landing page for an information marketplace, with a Rent a Kitten form preview, an AI search consultation offer, and contact links.

The rental preview validates the research brief and image attachments and generates a demo tracking ID. It uses sample payment options and keeps form data in the browser.

## Local development

No dependencies or build step. From this directory, run:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open the local server in your browser. The homepage is `index.html` and the rental form is `rent-a-kitten.html`. Images are in `assets/`.

## GitHub Pages

Push these files to the `main` branch. In the GitHub repository, open **Settings → Pages**, choose **Deploy from a branch**, and select **main / (root)**. Relative asset paths support both project sites and a future custom domain. No API keys or server are required.

The typography uses Google Fonts with local system fallbacks. All kitten images are served from this repository.

## Stripe PayNow checkout

The Node backend in `checkout/` saves rental briefs and optional reference images to a private SQLite database. It creates a one-time S$20 Checkout Session with the **UnemployedKittens** display name and confirms the rental only after Stripe sends a signed event for the matching paid session. The paid return page displays the tracking ID. Email, Telegram alerts, and the customer progress page require separate integrations.

1. Deploy `checkout/` on a Node 24 HTTPS host with a persistent private volume. Run `npm ci` and `npm start` from that directory. Use `checkout/.env.example` as the environment variable reference. Set `RENTALS_DB_PATH` to a path on the private volume and `SITE_ORIGIN` to the website origin.
2. In a Stripe sandbox, configure a one-time SGD 20 rental price and a payment method configuration with PayNow enabled. Set `STRIPE_RENTAL_PRICE_ID` and `STRIPE_PAYMENT_METHOD_CONFIGURATION` to their IDs. Store `STRIPE_RESTRICTED_KEY`, with Checkout Sessions write access, in the host's secret store.
3. In Stripe Workbench, register `https://<checkout-host>/api/stripe/webhook` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, and `checkout.session.expired`. Store the webhook endpoint's signing secret as `STRIPE_WEBHOOK_SECRET`.
4. Set the `rental-checkout-api` meta tag in a staging copy of `rent-a-kitten.html` to the API's HTTPS origin. Run a full sandbox payment, check that the success page shows a tracking ID, and verify the paid rental in the private database. Repeat the configuration with the live price, restricted key, and webhook endpoint before setting the meta tag on the public website. An empty meta tag keeps the public form in preview mode.

Run `npm test` from `checkout/` to test the request and signed webhook flow locally. The `rentals` table stores the tracking ID, payment state, and brief in `brief_json` for owner review via the private database. Keep database files and backups outside the static site.
