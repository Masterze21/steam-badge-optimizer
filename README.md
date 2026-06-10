# Steam Badge Optimizer — Chrome Extension

> Automate your Steam badge farming: one algorithm decides what to **sell** (instant sell, into the best buy order) and what to **buy** (lowest ask, instant fill) to **maximize XP**, then crafts the badges and grinds leftovers into gems.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![Version](https://img.shields.io/badge/version-2.0.0-orange)
![License MIT](https://img.shields.io/badge/License-MIT-green)

---

## How it works

### The algorithm (single, XP-first)

Every badge craft grants exactly **100 XP**, regardless of level. Maximizing XP therefore means **maximizing the number of crafts** your budget allows:

1. **Budget** = your real Steam wallet balance + the instant-sell value of every card in your inventory
2. **Cost of each badge level step** = missing cards (bought at the lowest ask, fills instantly) + owned cards consumed (opportunity cost: you give up selling them)
3. **Greedy selection by priority queue**: cheapest craft steps first — multi-level chains included — until the budget runs out
4. Every card **not consumed** by a selected craft goes to the **sell list**

### Instant sell (real order book)

Sales are not listed at a wishful price: the extension resolves the **real highest buy order** from Steam's order book (`itemordershistogram`) right before listing each card, and sells **into** it for immediate execution. Cards with no buy order are skipped. Item name-IDs are cached forever; histogram calls are throttled (~1 call / 3.2 s) to respect Steam's rate limit.

> ⚠️ Steam requires you to **confirm each listing in the Steam Mobile app** — that's a Steam rule, no tool can bypass it.

### Buying

Missing cards are acquired through buy orders placed **at the lowest ask**, so they match existing listings instantly. Buy orders need your billing address: open any market buy dialog once (no need to confirm) and the extension captures it automatically.

---

## Features

- **Scan Inventory** — inventory, badge pages and full market prices (cards + backgrounds + emoticons), with a 6-hour price cache
- **Sell Duplicates** — instant sell at the real best buy order
- **Complete & Craft** — instant-fill buy orders, then crafts every selected badge level (+100 XP each)
- **Convert to Gems** — smart grind: backgrounds/emoticons worth more on the market than as gems are **spared** (threshold configurable)
- **Execution report** — every run ends with a visible report on the dashboard: listed / skipped / errors (with the first error message)

### Parameters

| Setting | Effect |
|---------|--------|
| Max badge level | Cap craft chains (1–5) |
| Include foil cards | Also analyze foil badges |
| Multi-level crafting | Allow several levels of the same badge in one plan |
| Max cost per craft | Skip steps whose cash cost exceeds the threshold |
| Smart grind + threshold | Don't grind items worth more than N cents |
| Excluded AppIDs | Games the tool must never touch |
| Action delay | Pacing between Steam requests |

---

## Installation

> Not on the Chrome Web Store. Install in developer mode:

1. **Clone** this repo or download the ZIP
2. Open `chrome://extensions/`
3. Enable **Developer mode** (top-right)
4. Click **Load unpacked** and select the `extension/` folder

## Usage

1. Log in on [steamcommunity.com](https://steamcommunity.com) (session is read automatically from cookies)
2. Click **Scan Inventory**
3. Run **Sell Duplicates** → confirm the listings in the Steam Mobile app
4. For buys: open a market buy dialog once so billing info gets captured, then run **Complete & Craft**
5. Optionally **Convert to Gems**

---

## Privacy

- **No data leaves your browser** — the extension only talks to `steamcommunity.com`, like your normal browsing
- No password and no Steam Guard code is ever read or stored
- Session is read from Steam's own cookies via the `cookies` permission; billing fields are captured locally from Steam's pre-filled buy form and stored in `chrome.storage.local`
- `declarativeNetRequest` is used solely to set correct `Referer`/`Origin` headers on the extension's *own* Steam API calls (MV3 forbids setting them on `fetch`)

---

## Project structure

```
extension/
├── manifest.json
├── background/
│   └── service-worker.js     # Orchestration, queues, reports, DNR header rules
├── content/
│   ├── steam-bridge-main.js  # MAIN world: session vars + fetch/XHR billing hooks
│   └── steam-bridge.js       # ISOLATED world: storage bridge + DOM billing capture
├── lib/
│   ├── steam-api.js          # Steam endpoints (inventory, market, histogram, craft…)
│   ├── optimizer.js          # THE algorithm: max-XP greedy planner + queues
│   ├── pricing.js            # Steam fee formula, price map, name variants
│   ├── inventory.js          # Inventory parsing
│   ├── badges.js             # Badge page HTML parsing
│   └── storage.js            # chrome.storage wrappers (plan, queues, caches, report)
├── popup/
│   ├── popup.html / .css / .js
└── icons/
```

---

## Disclaimer

This tool automates marketplace actions on your own account. Use it responsibly: keep reasonable delays, and remember the author is not responsible for any account restrictions.

## License

[MIT](LICENSE) — © 2026 Masterze21
