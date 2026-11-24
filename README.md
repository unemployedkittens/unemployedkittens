# Unemployed Kittens

A responsive static landing page for an information marketplace, with a Rent a Kitten form preview, an AI search consultation offer, and contact links.

The rental preview validates the research brief and image attachments and generates a demo tracking ID. It uses sample payment options and keeps form data in the browser. Live rentals will need payment links or QR codes, a submission endpoint, persistent tracking IDs, Telegram notifications, and email delivery for the owner and requester.

## Local development

No dependencies or build step. From this directory, run:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open the local server in your browser. The homepage is `index.html` and the rental form is `rent-a-kitten.html`. Images are in `assets/`.

## GitHub Pages

Push these files to the `main` branch. In the GitHub repository, open **Settings → Pages**, choose **Deploy from a branch**, and select **main / (root)**. Relative asset paths support both project sites and a future custom domain. No API keys or server are required.

The typography uses Google Fonts with local system fallbacks. All kitten images are served from this repository.
