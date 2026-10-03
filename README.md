**This is just the README. The actual site can be found at https://sunnyvale-weather.shishir-iyer62.workers.dev/**

This is a website I made to display the data from my backyard weather station in a "readable" format. At the very top, current data is displayed, and farther down are the graphs for various variables, such as temperature, wind speed, and rainfall. On another tab the NWS forecast for Sunnyvale is displayed, with the current watches and warnings issued for the area. Historical data is also available, with monthly & yearly graphs for data taken from my spreadsheet.

### Todo

  * A radar loop in the forecast section (or maybe below the dashboard, not sure yet)
  * Need a climatology section + more tables & details per month

### Local development

```
npm install
cp .dev.vars.example .dev.vars   # fill in keys, this file is gitignored
npm run dev
```

This runs the static site and the `/api/current` route together via `wrangler dev`.
