**This is just the README. The actual site can be found at https://sunnyvale-weather.shishir-iyer62.workers.dev/**

Update (09-27-2026): Didn't think I'd ever return to this repo. Currently vibe-rewriting everything to eventually use data from my weather spreadsheet, but for now we just have the dashboard for current conditions.

## Old README

This is a website I made to display the data from my backyard weather station in a "readable" format. At the very top, current data is displayed, and farther down are the graphs for various variables, such as temperature, wind speed, and rainfall. Also, close to the top the NWS forecast for Sunnyvale is displayed, with the latest radar image and the current watches and warnings issued for the area.

### Bugs / Inconveniences

  * Alerts take a while (around 30 seconds) to display.
  * When the website is viewed on a phone, it looks super ugly.
  * The page must be refreshed to view the latest radar image. Clicking the refresh button in the webpage will not suffice.
  * Only data over the last 24 hours is displayed.

Static frontend (`public/index.html`, `public/style.css`, `public/script.js`) polls `/api/current` every 60 seconds. It's served as a Cloudflare Worker with static assets (`src/index.js` handles `/api/current`; everything else falls through to the `public/` assets).

### Local development

```
npm install
cp .dev.vars.example .dev.vars   # fill in keys, this file is gitignored
npm run dev
```

This runs the static site and the `/api/current` route together via `wrangler dev`.
