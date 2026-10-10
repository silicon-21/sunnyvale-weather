**This is just the README. The actual site can be found at https://sunnyvale-weather.shishir-iyer62.workers.dev/**

This is a website I made to display the data from my backyard weather station in a "readable" format. At the very top, current data is displayed, and farther down are the graphs for various variables, such as temperature, wind speed, and rainfall. On another tab the NWS forecast for Sunnyvale is displayed, with the current watches and warnings issued for the area. Historical data is also available, with monthly & yearly graphs for data taken from my spreadsheet.

### Todo

  * A radar loop in the forecast section (or maybe below the dashboard, not sure yet)
  * Need a climatology section + more tables & details per month
    * Seasonal totals / graphs
    * Graph for monthly stats in another section
  * Custom icons for the forecast - use https://www.weather.gov/forecast-icons for full list

Sky cover (the base set, no precip): skc clear, few few clouds, sct partly cloudy, bkn mostly cloudy, ovc overcast — each also has a wind_ variant (e.g. wind_skc) for "and windy."

Precipitation (combine with cloud cover in the real feed, e.g. tsra_sct):
- ra rain, shra rain showers, hi_shwrs isolated/slight-chance showers
- sn snow, ra_sn rain/snow mix, snip snow/ice pellets
- fzra freezing rain, ra_fzra rain + freezing rain, fzra_sn freezing rain/snow
- ip ice pellets/sleet, raip rain/ice pellets
- tsra thunderstorms, scttsra scattered thunderstorms, hi_tsra isolated thunderstorms

Severe/hazard: fc funnel cloud, tor tornado, hur_warn/hur_watch hurricane, ts_warn/ts_watch tropical storm, blizzard

Obstructions/extremes: fg fog/mist, du dust/sand, fu smoke, hz haze, hot, cold

Night versions use an n prefix (nbkn)

### Local development

```
npm install
cp .dev.vars.example .dev.vars   # fill in keys, this file is gitignored
npm run dev
```

This runs the static site and the `/api/current` route together via `wrangler dev`.
