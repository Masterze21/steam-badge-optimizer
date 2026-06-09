# Steam Badge Optimizer — Chrome Extension

> Automate your Steam badge farming: sell duplicate cards, buy missing ones, craft badges, and grind items into gems — all from a single popup.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![License MIT](https://img.shields.io/badge/License-MIT-green)

---

## Features

- **Scan Inventory** — analyzes your Steam inventory, all your badge pages, and live market prices in one click
- **Sell Duplicates** — automatically lists your extra cards at the best market price
- **Complete & Craft** — places buy orders for missing cards, then crafts the badges
- **Convert to Gems** — grinds backgrounds and emoticons into gems

### Optimization Algorithm

4 strategies to choose from:

| Strategy | Description |
|----------|-------------|
| **Max ROI** | Maximizes XP gained per cent spent |
| **Max XP** | Maximizes total XP earned |
| **Max Badges** | Maximizes the number of badges crafted |
| **Max Profit** | Prioritizes badges that generate net profit |

Badge categories detected automatically:

| Category | Meaning |
|----------|---------|
| 🟢 **Free** | You already own all the cards — craft costs nothing |
| 🟡 **Profitable** | Net cost is negative — crafting actually earns money |
| 🔵 **Efficient** | Great XP-per-cent ratio (≥ 2 XP / ¢) |
| 🔴 **Expensive** | Craftable but less cost-efficient |

---

## Installation

> This extension is not on the Chrome Web Store. Install it in developer mode:

1. **Clone** this repo or download the ZIP
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked**
5. Select the `extension/` folder

---

## How to Use

1. **Log in** on [steamcommunity.com](https://steamcommunity.com) — the session is detected automatically
2. **For buy orders**: place one market order manually on Steam first (the extension will capture the required billing fields)
3. Open the extension, pick your strategy under **Settings**
4. Click **Scan Inventory**
5. Run the actions in any order you prefer

---

## Privacy

- **No data is sent to any external server**
- The extension only communicates with **steamcommunity.com** — the same requests your browser already makes
- No password, no Steam Guard code is ever read or stored
- The Steam session (`sessionID`) is read from the page already open in your browser
- Everything is stored locally via `chrome.storage` (inventory cached for 6 hours, settings persisted)

---

## Project Structure

```
extension/
├── manifest.json
├── background/
│   └── service-worker.js     # Core logic, queue management, rate limiting
├── content/
│   └── steam-bridge.js       # Captures sessionID + billing info from the Steam page
├── lib/
│   ├── steam-api.js          # Steam API calls (inventory, market, craft…)
│   ├── inventory.js          # Inventory parsing
│   ├── badges.js             # Badge page HTML parsing
│   ├── pricing.js            # Steam fee formula, price cache
│   ├── optimizer.js          # Optimization algorithm (4 strategies)
│   └── storage.js            # chrome.storage wrappers
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
└── icons/
```

---

## Disclaimer

This tool automates actions on the Steam marketplace. Use it responsibly:
- Respect Steam API rate limits (configurable delay in Settings)
- The author is not responsible for any account restrictions

---

## License

[MIT](LICENSE) — © 2026 Masterze21
