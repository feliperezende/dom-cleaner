const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");

const bg = require("../background.js");
const content = require("../content.js");

describe("DOM Cleaner - Background Service Worker", () => {
  beforeEach(() => {
    bg.classificationCache.clear();
  });

  it("hashes text deterministically", () => {
    const text = "[TAG: VIDEO] [CLASS: outstream] [TEXT: Click here for 50% discount]";
    const h1 = bg.hashText(text);
    const h2 = bg.hashText(text);
    assert.strictEqual(h1, h2);
    assert.strictEqual(typeof h1, "string");
  });

  it("stores and retrieves classification results from cache", () => {
    const text = "[TAG: DIV] [ID: sponsored-banner] [TEXT: Buy now]";
    const resultObj = {
      label: "advertisement or sponsored content",
      confidence: 0.94,
      scores: { "advertisement or sponsored content": 0.94 }
    };

    assert.strictEqual(bg.getCachedResult(text), null);
    bg.cacheResult(text, resultObj);

    const cached = bg.getCachedResult(text);
    assert.deepStrictEqual(cached, resultObj);
  });

  it("strictly bounds snippet cache to CACHE_MAX_SIZE with LRU eviction", () => {
    assert.strictEqual(bg.CACHE_MAX_SIZE, 300);
    for (let i = 0; i < 320; i++) {
      bg.cacheResult(`snippet text #${i}`, {
        label: "content",
        confidence: 0.9,
        scores: {}
      });
    }

    assert.strictEqual(bg.classificationCache.size, 300);
    // Oldest items (0-19) should have been evicted
    assert.strictEqual(bg.getCachedResult("snippet text #0"), null);
    assert.strictEqual(bg.getCachedResult("snippet text #15"), null);
    // Newest items should exist
    assert.ok(bg.getCachedResult("snippet text #315"));
  });

  it("produces distinct hashes for different text inputs with 64-bit FNV-1a", () => {
    const h1 = bg.hashText("[TAG: DIV] [ID: ad-slot-1]");
    const h2 = bg.hashText("[TAG: DIV] [ID: ad-slot-2]");
    const h3 = bg.hashText("[TAG: VIDEO] [CLASS: outstream]");
    assert.notStrictEqual(h1, h2);
    assert.notStrictEqual(h2, h3);
    assert.notStrictEqual(h1, h3);
  });

  it("batches multiple classify requests into a single POST call", async () => {
    let fetchCalled = false;
    let requestPayload = null;

    // Mock global fetch
    global.fetch = async (url, options) => {
      fetchCalled = true;
      requestPayload = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          results: [
            { label: "advertisement or sponsored content", confidence: 0.92, scores: {} },
            { label: "autoplay video player", confidence: 0.88, scores: {} }
          ]
        })
      };
    };

    const p1 = bg.classifyItem("Ad snippet 1");
    const p2 = bg.classifyItem("Autoplay snippet 2");

    // Force flush the queued batch
    await bg.flushBatch();

    const [r1, r2] = await Promise.all([p1, p2]);

    assert.strictEqual(fetchCalled, true);
    assert.strictEqual(requestPayload.inputs.length, 2);
    assert.strictEqual(requestPayload.inputs[0], "Ad snippet 1");
    assert.strictEqual(requestPayload.inputs[1], "Autoplay snippet 2");

    assert.strictEqual(r1.label, "advertisement or sponsored content");
    assert.strictEqual(r1.confidence, 0.92);
    assert.strictEqual(r2.label, "autoplay video player");
    assert.strictEqual(r2.confidence, 0.88);
  });

  it("evaluates shouldRemoveResult correctly for single labels and split scores", () => {
    // Direct ad match
    const adResult = {
      label: "advertisement or promotional ad",
      confidence: 0.95,
      scores: { "advertisement or promotional ad": 0.95, "legitimate main website content": 0.05 }
    };
    assert.strictEqual(bg.shouldRemoveResult(adResult, 0.75), true);

    // Cookie consent match
    const cookieResult = {
      label: "cookie consent or privacy notice modal",
      confidence: 0.98,
      scores: { "cookie consent or privacy notice modal": 0.98, "legitimate main website content": 0.02 }
    };
    assert.strictEqual(bg.shouldRemoveResult(cookieResult, 0.75), true);

    // Split between ad and autoplay video (both unwanted)
    const splitResult = {
      label: "intrusive autoplay video player",
      confidence: 0.52,
      scores: {
        "advertisement or promotional ad": 0.40,
        "intrusive autoplay video player": 0.55,
        "legitimate main website content": 0.05
      }
    };
    assert.strictEqual(bg.shouldRemoveResult(splitResult, 0.75), true);

    // Legitimate content
    const contentResult = {
      label: "legitimate main website content",
      confidence: 0.99,
      scores: {
        "advertisement or promotional ad": 0.01,
        "intrusive autoplay video player": 0.00,
        "legitimate main website content": 0.99
      }
    };
    assert.strictEqual(bg.shouldRemoveResult(contentResult, 0.75), false);
  });
});

describe("DOM Cleaner - Content Script Heuristics & Extraction", () => {
  it("identifies autoplay video candidate correctly", () => {
    const videoMock = {
      nodeType: 1,
      tagName: "VIDEO",
      autoplay: true,
      muted: true,
      hasAttribute: (attr) => attr === "autoplay" || attr === "muted"
    };

    assert.strictEqual(content.isCandidateElement(videoMock), true);
  });

  it("rejects protected tags like MAIN or ARTICLE even with classes", () => {
    const mainMock = {
      nodeType: 1,
      tagName: "MAIN",
      className: "ad-section",
      hasAttribute: () => false
    };

    assert.strictEqual(content.isCandidateElement(mainMock), false);
  });

  it("identifies ad iframes from known ad domains", () => {
    const iframeMock = {
      nodeType: 1,
      tagName: "IFRAME",
      src: "https://securepubads.g.doubleclick.net/gampad/ads?iu=...",
      hasAttribute: () => false
    };

    assert.strictEqual(content.isCandidateElement(iframeMock), true);
  });

  it("identifies elements with suspicious ad or sponsored classes", () => {
    const sponsoredDiv = {
      nodeType: 1,
      tagName: "DIV",
      className: "promoted-item sponsor-card",
      hasAttribute: () => false
    };

    assert.strictEqual(content.isCandidateElement(sponsoredDiv), true);
  });

  it("identifies cookie consent banners by class or ID", () => {
    const oneTrustBanner = {
      nodeType: 1,
      tagName: "DIV",
      id: "onetrust-consent-sdk",
      className: "ot-sdk-container",
      hasAttribute: () => false
    };
    assert.strictEqual(content.isCandidateElement(oneTrustBanner), true);

    const lgpdBanner = {
      nodeType: 1,
      tagName: "DIV",
      className: "uol-lgpd-banner aviso-cookies",
      hasAttribute: () => false
    };
    assert.strictEqual(content.isCandidateElement(lgpdBanner), true);
  });

  it("unlocks scroll and removes modal classes", () => {
    const docEl = {
      style: { overflow: "hidden" },
      classList: {
        classes: new Set(["modal-open", "no-scroll"]),
        remove(...names) { names.forEach(n => this.classes.delete(n)); }
      }
    };
    const body = {
      style: { overflow: "hidden", position: "fixed" },
      classList: {
        classes: new Set(["ot-no-scroll"]),
        remove(...names) { names.forEach(n => this.classes.delete(n)); }
      }
    };

    global.document = {
      documentElement: docEl,
      body: body,
      querySelectorAll: () => []
    };

    content.unlockPageScroll();

    assert.strictEqual(docEl.style.overflow, "");
    assert.strictEqual(body.style.overflow, "");
    assert.strictEqual(body.style.position, "");
    assert.strictEqual(docEl.classList.classes.has("modal-open"), false);
    assert.strictEqual(body.classList.classes.has("ot-no-scroll"), false);
  });

  it("rejects already scanned elements", () => {
    const alreadyScanned = {
      nodeType: 1,
      tagName: "DIV",
      className: "ad-banner",
      hasAttribute: (attr) => attr === "data-dc-scanned"
    };

    assert.strictEqual(content.isCandidateElement(alreadyScanned), false);
  });

  it("extracts structured metadata snippets for classifier.dev", () => {
    const mockElement = {
      tagName: "DIV",
      id: "taboola-right-rail",
      className: "ad-unit sponsor-box",
      getAttribute: (attr) => (attr === "aria-label" ? "Advertisements" : null),
      innerText: "Trending news stories you might like from around the web"
    };

    const snippet = content.extractElementSnippet(mockElement);

    assert.match(snippet, /\[TAG: DIV\]/);
    assert.match(snippet, /\[ID: taboola-right-rail\]/);
    assert.match(snippet, /\[CLASS: ad-unit sponsor-box\]/);
    assert.match(snippet, /\[ARIA: Advertisements\]/);
    assert.match(snippet, /\[TEXT: Trending news stories/);
  });

  it("identifies deterministic ads and cookie banners instantly via fast-path", () => {
    const adIframe = {
      nodeType: 1,
      tagName: "IFRAME",
      src: "https://securepubads.g.doubleclick.net/pagead/ads?client=ca-pub-123"
    };
    const fastAd = content.isDeterministicUnwanted(adIframe);
    assert.ok(fastAd);
    assert.strictEqual(fastAd.type, "ad");
    assert.strictEqual(fastAd.label, "advertisement (known ad network iframe)");

    const cmpBanner = {
      nodeType: 1,
      tagName: "DIV",
      id: "onetrust-consent-sdk",
      className: "ot-sdk-container"
    };
    const fastCookie = content.isDeterministicUnwanted(cmpBanner);
    assert.ok(fastCookie);
    assert.strictEqual(fastCookie.type, "cookie");
    assert.strictEqual(fastCookie.label, "cookie consent or privacy notice modal");

    const taboolaWidget = {
      nodeType: 1,
      tagName: "DIV",
      className: "taboola-feed-container"
    };
    const fastTaboola = content.isDeterministicUnwanted(taboolaWidget);
    assert.ok(fastTaboola);
    assert.strictEqual(fastTaboola.type, "ad");

    // Regular article should NOT match fast-path
    const article = {
      nodeType: 1,
      tagName: "DIV",
      className: "article-content main-text"
    };
    assert.strictEqual(content.isDeterministicUnwanted(article), null);
  });
});

describe("DOM Cleaner - AI Network Domain Classifier", () => {
  beforeEach(() => {
    bg.knownDomains.clear();
  });

  it("extracts hostnames accurately from full URLs", () => {
    assert.strictEqual(
      bg.extractDomain("https://securepubads.g.doubleclick.net/gampad/ads?id=123"),
      "securepubads.g.doubleclick.net"
    );
    assert.strictEqual(
      bg.extractDomain("http://trc.taboola.com/uol/log/3"),
      "trc.taboola.com"
    );
    assert.strictEqual(bg.extractDomain("data:image/png;base64,123"), null);
    assert.strictEqual(bg.extractDomain("chrome-extension://xyz/content.js"), null);
  });

  it("identifies and ignores internal and self-domains", () => {
    assert.strictEqual(bg.isIgnoredDomain("classifier.dev"), true);
    assert.strictEqual(bg.isIgnoredDomain("api.classifier.dev"), true);
    assert.strictEqual(bg.isIgnoredDomain("localhost"), true);
    assert.strictEqual(bg.isIgnoredDomain("127.0.0.1"), true);
    assert.strictEqual(bg.isIgnoredDomain("accounts.google.com"), true);

    assert.strictEqual(bg.isIgnoredDomain("securepubads.g.doubleclick.net"), false);
    assert.strictEqual(bg.isIgnoredDomain("trc.taboola.com"), false);
    assert.strictEqual(bg.isIgnoredDomain("cdn.jsdelivr.net"), false);
  });

  it("classifies domains with classifier.dev and creates dynamic blocking rules", async () => {
    let dnrAddedRules = [];
    global.chrome = {
      declarativeNetRequest: {
        updateDynamicRules: async ({ addRules }) => {
          dnrAddedRules = addRules || [];
        }
      },
      storage: {
        local: {
          set: async () => {},
          get: async () => ({})
        }
      }
    };

    // Mock global fetch for classifier.dev domain classification
    global.fetch = async (url, options) => {
      const payload = JSON.parse(options.body);
      assert.strictEqual(payload.inputs.length, 2);
      assert.strictEqual(payload.inputs[0], "Domain: securepubads.g.doubleclick.net");
      assert.strictEqual(payload.inputs[1], "Domain: cdn.jsdelivr.net");

      return {
        ok: true,
        json: async () => ({
          results: [
            {
              label: "advertising or tracking domain",
              confidence: 0.98,
              scores: { "advertising or tracking domain": 0.98 }
            },
            {
              label: "legitimate content or utility domain",
              confidence: 0.99,
              scores: { "legitimate content or utility domain": 0.99 }
            }
          ]
        })
      };
    };

    // Trigger domain observation
    bg.observeDomainRequest("https://securepubads.g.doubleclick.net/pagead/ad.js");
    bg.observeDomainRequest("https://cdn.jsdelivr.net/npm/vue.js");

    // Flush the domain batch
    await bg.flushDomainBatch();

    // Verify knownDomains state
    const adDomain = bg.knownDomains.get("securepubads.g.doubleclick.net");
    const cdnDomain = bg.knownDomains.get("cdn.jsdelivr.net");

    assert.ok(adDomain);
    assert.strictEqual(adDomain.status, "blocked");
    assert.strictEqual(adDomain.confidence, 0.98);

    assert.ok(cdnDomain);
    assert.strictEqual(cdnDomain.status, "allowed");

    // Verify declarativeNetRequest rule generation
    assert.strictEqual(dnrAddedRules.length, 1);
    assert.strictEqual(dnrAddedRules[0].action.type, "block");
    assert.strictEqual(dnrAddedRules[0].condition.urlFilter, "||securepubads.g.doubleclick.net^");
    assert.ok(dnrAddedRules[0].condition.resourceTypes.includes("script"));
    assert.ok(dnrAddedRules[0].condition.resourceTypes.includes("sub_frame"));
  });

  it("strictly caps knownDomains with LRU eviction to DOMAIN_MAX_CACHE_SIZE", () => {
    assert.strictEqual(bg.DOMAIN_MAX_CACHE_SIZE, 300);

    for (let i = 0; i < 310; i++) {
      bg.recordKnownDomain(`example-${i}.com`, {
        status: i % 2 === 0 ? "allowed" : "blocked",
        confidence: 0.95,
        ruleId: i + 1,
        timestamp: Date.now() + i
      });
    }

    assert.strictEqual(bg.knownDomains.size, 300);
    // Allowed early domains should have been evicted first
    assert.strictEqual(bg.knownDomains.has("example-0.com"), false);
    // Most recent domains should be retained
    assert.strictEqual(bg.knownDomains.has("example-309.com"), true);
  });
});
