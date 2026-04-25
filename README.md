# NOLA JazzFest ScheduleBot

A swipe-based schedule browser for the New Orleans Jazz & Heritage Festival 2026, installable as an iOS PWA.

## Live site

Once deployed: https://natea.github.io/nola-jazzfest-schedulebot/

## Install on iPhone

Open the URL in **Safari** → tap Share → "Add to Home Screen". Launches full-screen, works offline after first load.

## Updating the schedule

Edit `schedule.js` and push. To force-refresh installed PWAs, bump `CACHE_VERSION` in `sw.js`.

## Files

- `index.html` — entry point (PWA-enabled)
- `schedule.js` — performer/stage/time data for all 8 days, all 14 stages
- `app.jsx` — main UI
- `ios-frame.jsx`, `tweaks-panel.jsx` — supporting components
- `manifest.json`, `sw.js` — PWA manifest + service worker
- `icon-*.png`, `apple-touch-icon.png` — icons

## Local dev

```bash
python3 -m http.server 8000
# open http://localhost:8000
```
