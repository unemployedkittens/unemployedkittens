# Unemployed Kittens

A responsive static landing page for a future information marketplace. Includes original AI-generated alien kitten imagery, two service cards with coming-soon dialogs, About, and contact links. Rentals, payments, listings, and research bots are not implemented yet.

## Local development

No dependencies or build step. From this directory, run:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open the local server in your browser. Edit `index.html`, `styles.css`, and `script.js` directly. Images are in `assets/`.

## GitHub Pages

Push these files to the `main` branch. In the GitHub repository, open **Settings → Pages**, choose **Deploy from a branch**, and select **main / (root)**. Relative asset paths support both project sites and a future custom domain. No API keys or server are required.

The typography uses Google Fonts with local system fallbacks. All kitten images are served from this repository.
