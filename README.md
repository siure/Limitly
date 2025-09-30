# Limitly

Limitly is a Chrome extension that keeps distracting sites in check. Add the domains you want to manage, choose a daily or weekly allowance, and the extension will block access automatically once you hit the limit.

## Features

- ✏️ Configure any website with a per-day or per-week cap (minutes).
- � Track time without limits—enable "stats only" mode to monitor usage without blocking.
- �🕒 Limit tracking to a daily time window with a dual-handle slider.
- 🌗 Invert the window to count time outside of quiet hours when you need the reverse.
- ⏱ Tracks active time on the site while the tab is focused.
- ⚡ One-click "Use current" button and inline editing keep site settings up to date.
- 🚫 Automatically redirects to a friendly block page when the quota is reached.
- 🔁 Resets usage automatically at the start of the next period (midnight for daily, Monday for weekly).
- 🧮 Quick view of remaining time plus enable/disable, reset, and remove controls from the popup.
- 📊 Dedicated stats tab with today's total focused time, top sites (with per-site session insights), and a 7-day trend sparkline.
- 🖥 Pop the popup into a full-page dashboard whenever you need extra breathing room.

## Install locally

1. Clone or download this repository.
2. Open **chrome://extensions** in Chromium-based browsers.
3. Toggle on **Developer mode** (top right).
4. Click **Load unpacked** and select this project folder.
5. Pin the extension to your toolbar for faster access.


## Usage

1. Click the extension icon to open the popup.
2. Need extra space? Hit **Open full view** in the header to pop the UI into its own tab.
3. Enter a domain (or hit **Use current**), choose a time limit in minutes, pick *per day* or *per week*, and drag the handles to set the daily tracking window.
4. Want to track time without enforcing a limit? Check **Track without limiting (stats only)** to monitor usage without blocking—perfect for awareness without restrictions.
5. Select **Track outside the selected window** if you want the limit to apply everywhere except the highlighted range.
6. Toggle a tracked site on/off at any time without deleting it, or use **Edit** to adjust its settings later.
7. Flip to the **Stats** tab for a quick pulse on today's focused time across the browser, session behavior, per-site averages, and your 7-day trend. Tap **Show more** to expand the top-sites list when you need the full breakdown.
8. When you browse, the extension keeps track of active time in focused tabs during the configured window. Once the limit is used up, every matching tab is redirected to the block page.
9. Time spent resets automatically at the start of the next period. You can manually reset or remove a site from the popup if needed.

> **Tip:** Add the base domain (like `reddit.com`) to cover common subdomains such as `www.reddit.com` or `old.reddit.com`.

## Development notes

- Manifest V3 service worker (`background.js`) stores site configuration and usage in `chrome.storage.local` and ticks every 15 seconds via `chrome.alarms`.
- Only the active, focused tab counts toward the total. Switching tabs or windows pauses tracking.
- Today's total focused time includes any HTTP(S) page you keep in the foreground (extension pages, settings, and blank tabs are ignored), while per-site stats still respect your tracked list.
- Time resets use the local timezone: daily resets at midnight, weekly resets at the start of Monday.
- The block page (`blocked.html`) offers quick links to adjust settings or jump back to a fresh tab.

## Folder overview

| File | Purpose |
| --- | --- |
| `manifest.json` | Chrome extension manifest (MV3). |
| `background.js` | Service worker tracking usage, enforcing limits, and handling popup requests. |
| `popup.html / popup.js / popup.css` | Popup UI to manage sites and limits. |
| `blocked.html / blocked.js / blocked.css` | Page shown when a limit is reached. |
| `logo.png` | Original extension logo (hourglass icon). |
| `icon16.png / icon48.png / icon128.png` | Resized icons for Chrome extension display. |
| `README.md` | You're reading it. |

## Troubleshooting

- **Extension doesn't appear in toolbar:** Click the puzzle icon and pin "Limitly".
- **Nothing happens on a site:** Ensure the domain matches (use the base domain) and the popup shows the entry with remaining time.
- **Want to allow a site again sooner?** Use the *Reset* button in the popup.

Pull requests and suggestions are welcome!
