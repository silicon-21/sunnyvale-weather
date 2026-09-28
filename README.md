# Sunnyvale Weather

Update (09-27-2026): Didn't think I'd ever return to this repo. Currently vibe-rewriting everything to eventually use data from my weather spreadsheet, but for now we just have the dashboard for current conditions.

## Old README

This is a website I made to display the data from my backyard weather station in a "readable" format. At the very top, current data is displayed, and farther down are the graphs for various variables, such as temperature, wind speed, and rainfall. Also, close to the top the NWS forecast for Sunnyvale is displayed, with the latest radar image and the current watches and warnings issued for the area.

### Bugs / Inconveniences

  * Alerts take a while (around 30 seconds) to display.
  * When the website is viewed on a phone, it looks super ugly.
  * The page must be refreshed to view the latest radar image. Clicking the refresh button in the webpage will not suffice.
  * Only data over the last 24 hours is displayed.

Static frontend (`index.html`, `style.css`, `script.js`) polls `/api/current` every 60 seconds.

### Setup

1. Create an API key and application key at [ambientweather.net](https://ambientweather.net) (Account → API Keys), and find your station's MAC address.
2. In the Cloudflare Pages project settings, add these environment variables (as **secrets**, not plaintext vars):
   - `AMBIENT_API_KEY`
   - `AMBIENT_APPLICATION_KEY`
   - `AMBIENT_MAC_ADDRESS`
3. Connect this repo to a Cloudflare Pages project (or deploy with `wrangler pages deploy`). No build step is needed — the output directory is the repo root.

### Local development

```
npm install
cp .dev.vars.example .dev.vars   # fill in keys
npm run dev
```

This runs the static site and the `/api/current` function together via `wrangler pages dev`.
