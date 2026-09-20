# DOM Cleaner - AI Ad & Autoplay Blocker

A high-performance Chrome extension (Manifest V3) that intelligently detects and removes intrusive advertisements, autoplay video players, and cookie consent modals using a hybrid **0ms fast-path heuristic + zero-shot AI classification** via [classifier.dev](https://classifier.dev).

---

## Features

- **Hybrid Two-Tier Filtering:**
  - **Tier 1 (0ms Instant Fast-Path):** Immediately removes unambiguous ad iframes (`doubleclick.net`, `googlesyndication.com`, `taboola.com`, etc.) and standard CMP cookie banners (`#onetrust-consent-sdk`, Cookiebot, Didomi, LGPD/GDPR dialogs), unlocking page scroll without network delay or visual layout shift (CLS).
  - **Tier 2 (AI Zero-Shot Classifier):** Batches ambiguous elements and autoplay videos to [classifier.dev](https://classifier.dev) to discern between legitimate embedded media and promotional clutter.
- **Dynamic Network Pre-Blocking:**
  - Uses Chrome's native `declarativeNetRequest` engine to block known and AI-classified advertising/tracking domains at the network layer before download.
- **Low Memory & High Performance:**
  - **Zero Layout Thrashing:** Uses `textContent` metadata extraction instead of `innerText` to avoid forced browser reflows.
  - **Scoped Mutation Traversal:** Only inspects newly added nodes on infinite scroll/SPA routes instead of rescanning the entire `document.body`.
  - **Strict LRU Caching:** In-memory snippet and domain caches are capped at 300 items with LRU eviction to maintain a heap footprint under 2MB.
  - **64-bit FNV-1a Hashing:** Fast, collision-free snippet signature fingerprinting.
  - **Debounced Storage I/O:** Batches configuration and stats writes to minimize disk writes.
  - **Event-Driven Popup:** Reacts to storage events with zero polling overhead.
- **Interactive Popup Dashboard:**
  - Real-time counters for removed ads, blocked videos, dismissed cookie banners, and blocked domains.
  - Adjustable AI confidence threshold slider (50%–95%).
  - One-click active tab scanner with instant feedback.
  - Optional classifier.dev API key configuration (defaults to generous free tier).

---

## Project Structure

```
├── manifest.json         # Extension Manifest V3 configuration
├── background.js         # Service Worker (classifier API, DNR rules, LRU caching)
├── content.js            # Content script (fast-path heuristics, DOM mutation observer)
├── popup/
│   ├── popup.html        # Settings and statistics dashboard
│   ├── popup.css         # Modern, responsive dark UI styles
│   └── popup.js          # Popup controller & event handlers
├── icons/                # Extension icon assets (16px, 48px, 128px)
├── test-demo.html        # Interactive test page with simulated ads & banners
└── tests/
    └── extension.test.js # Node.js native unit test suite (19 test cases)
```

---

## Installation

### Load Unpacked in Chrome / Chromium / Brave / Edge

1. Clone or download this repository:
   ```bash
   git clone https://github.com/feliperezende/dom-cleaner.git
   ```
2. Open your browser and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `dom-cleaner` directory.
5. *(Optional)* If testing local HTML files (like `test-demo.html`), click **Details** on the DOM Cleaner card in `chrome://extensions/` and enable **Allow access to file URLs**.

---

## Testing & Verification

### Running Unit Tests

The test suite runs with Node.js's built-in test runner without external dependencies:

```bash
node --test tests/extension.test.js
```

Covers:
- Deterministic 64-bit FNV-1a text hashing.
- Snippet cache LRU eviction (strictly bounded to 300 items).
- Domain classification and dynamic `declarativeNetRequest` rule creation.
- Content script fast-path heuristic detection for ad iframes and cookie consent banners.
- Scroll unlocking and modal backdrop removal.

### Interactive Manual Testing

Open `test-demo.html` in your browser to verify real-time detection of:
- Simulated top advertisement banner.
- Autoplay muted outstream video container.
- Sponsored recommendation widget.
- Floating OneTrust / LGPD cookie consent banner.

Click **Scan Active Tab** in the extension popup to trigger an on-demand rescan with instant element-count feedback.

---

## Configuration

Click the extension icon in the toolbar to adjust:
- **Enable / Disable Protection:** Global toggle to pause or activate the extension.
- **Block Cookie Banners:** Automatically dismiss LGPD/GDPR consent modals and re-enable document scrolling.
- **AI Domain Pre-Blocking:** Intercept third-party network requests and create dynamic blocking rules.
- **Confidence Threshold:** Adjust how strictly or aggressively the AI should classify elements (default: `75%`).
- **API Key (Optional):** Add a custom [classifier.dev](https://classifier.dev) API key for Pro limits, or leave empty to use the free tier (3,000 classifications/min).

---

## License

MIT License. See individual source files for details.
