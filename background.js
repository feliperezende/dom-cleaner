/**
 * Background Service Worker for DOM Cleaner
 * Handles DOM element & domain classification via classifier.dev,
 * request batching, caching, settings, and declarativeNetRequest dynamic rule management.
 */

const DEFAULT_CONFIG = {
  enabled: true,
  domainBlockingEnabled: true,
  cookieBlockingEnabled: true,
  confidenceThreshold: 0.75,
  apiKey: "",
  labels: [
    "advertisement or promotional ad",
    "intrusive autoplay video player",
    "cookie consent or privacy notice modal",
    "legitimate main website content"
  ],
  instructions: "Determine whether the described web element is an advertisement/promotional ad, an intrusive autoplay video player, a cookie/GDPR/LGPD consent modal or banner, or legitimate main website content.",
  domainLabels: [
    "advertising or tracking domain",
    "legitimate content or utility domain"
  ],
  domainInstructions: "Classify whether each domain is primarily an advertising network, tracker, telemetry, or ad-delivery service, or a legitimate first-party content / CDN / utility domain.",
  stats: {
    totalScanned: 0,
    adsRemoved: 0,
    autoplayRemoved: 0,
    domainsBlocked: 0,
    cookiesBlocked: 0,
    apiRequests: 0,
    apiClassifications: 0,
    cacheHits: 0,
    lastLatencyMs: 0,
    totalLatencyMs: 0,
    rateLimitRemaining: null
  }
};

const CLASSIFIER_API_URL = "https://classifier.dev/v1/classify";
const BATCH_DEBOUNCE_MS = 250;
const MAX_BATCH_SIZE = 100;
const CACHE_MAX_SIZE = 300; // Strictly bounded snippet cache to minimize memory footprint

const DOMAIN_BATCH_DEBOUNCE_MS = 300;
const DOMAIN_MAX_BATCH_SIZE = 50;
const DOMAIN_MAX_CACHE_SIZE = 300; // Strict LRU bound for known domains

// In-memory cache for DOM snippets: signature -> { label, confidence, scores, timestamp }
const classificationCache = new Map();

// In-memory map for domains: domain -> { status: 'blocked' | 'allowed', confidence, ruleId?, timestamp }
const knownDomains = new Map();

// Pending queues
let pendingQueue = [];
let batchTimeout = null;

const pendingDomainSet = new Set();
let pendingDomainList = [];
let domainBatchTimeout = null;
let nextRuleId = 1;

// Active configuration
let currentConfig = { ...DEFAULT_CONFIG };

// Initialize settings, domain rules, and snippet cache from chrome.storage
let isStorageReady = false;
async function initStorage() {
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    try {
      const stored = await chrome.storage.local.get(["domCleanerConfig", "domCleanerDomainRules", "domCleanerSnippetCache"]);
      if (stored && stored.domCleanerConfig) {
        currentConfig = {
          ...DEFAULT_CONFIG,
          ...stored.domCleanerConfig,
          stats: {
            ...DEFAULT_CONFIG.stats,
            ...(stored.domCleanerConfig.stats || {})
          }
        };
      } else {
        await chrome.storage.local.set({ domCleanerConfig: DEFAULT_CONFIG });
      }

      if (stored && stored.domCleanerDomainRules && Array.isArray(stored.domCleanerDomainRules)) {
        stored.domCleanerDomainRules.forEach((item) => {
          if (item && item.domain) {
            recordKnownDomain(item.domain, item);
            if (item.ruleId && item.ruleId >= nextRuleId) {
              nextRuleId = item.ruleId + 1;
            }
          }
        });
      }

      if (stored && stored.domCleanerSnippetCache && Array.isArray(stored.domCleanerSnippetCache)) {
        const now = Date.now();
        stored.domCleanerSnippetCache.forEach(([key, item]) => {
          if (item && now - (item.timestamp || 0) < 60 * 60 * 1000) {
            if (classificationCache.size >= CACHE_MAX_SIZE) {
              const firstKey = classificationCache.keys().next().value;
              classificationCache.delete(firstKey);
            }
            classificationCache.set(key, item);
          }
        });
      }
    } catch (err) {
      console.warn("[DOM Cleaner] Failed to load config/domain rules from storage:", err);
    }
  }
  isStorageReady = true;
}

const storageInitPromise = initStorage();

let configSaveTimeout = null;
function saveConfigDebounced(delay = 1500) {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
  if (configSaveTimeout) return;
  configSaveTimeout = setTimeout(async () => {
    configSaveTimeout = null;
    try {
      await chrome.storage.local.set({ domCleanerConfig: currentConfig });
    } catch (err) {
      console.warn("[DOM Cleaner] Failed to save config:", err);
    }
  }, delay);
}

// Save updated config to storage (immediate for settings, debounced for frequent stats)
async function saveConfig(newConfig, immediate = false) {
  if (!isStorageReady) await storageInitPromise;
  currentConfig = {
    ...currentConfig,
    ...newConfig,
    stats: {
      ...currentConfig.stats,
      ...((newConfig && newConfig.stats) || {})
    }
  };

  if (immediate) {
    if (configSaveTimeout) {
      clearTimeout(configSaveTimeout);
      configSaveTimeout = null;
    }
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      try {
        await chrome.storage.local.set({ domCleanerConfig: currentConfig });
      } catch (err) {
        console.warn("[DOM Cleaner] Failed to save config:", err);
      }
    }
  } else {
    saveConfigDebounced(1500);
  }
}

// Manage known domains with strict LRU eviction to prevent memory growth
function recordKnownDomain(domain, data) {
  if (knownDomains.has(domain)) {
    knownDomains.delete(domain);
  } else if (knownDomains.size >= DOMAIN_MAX_CACHE_SIZE) {
    let evictKey = null;
    // Prefer evicting allowed domains first
    for (const [d, entry] of knownDomains.entries()) {
      if (entry.status === "allowed") {
        evictKey = d;
        break;
      }
    }
    if (!evictKey) {
      evictKey = knownDomains.keys().next().value;
    }
    const evicted = knownDomains.get(evictKey);
    knownDomains.delete(evictKey);
    // Remove dynamic rule if the evicted domain was blocked
    if (evicted && evicted.ruleId && typeof chrome !== "undefined" && chrome.declarativeNetRequest) {
      chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [evicted.ruleId] }).catch(() => {});
    }
  }
  knownDomains.set(domain, data);
}

// Persist domain rules to storage with bounded size
async function saveDomainRules() {
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    try {
      const list = Array.from(knownDomains.entries()).slice(-DOMAIN_MAX_CACHE_SIZE).map(([domain, data]) => ({
        domain,
        ...data
      }));
      await chrome.storage.local.set({ domCleanerDomainRules: list });
    } catch (err) {
      console.warn("[DOM Cleaner] Failed to save domain rules:", err);
    }
  }
}

// 64-bit FNV-1a deterministic hash to eliminate collision false positives
function hashText(text) {
  if (typeof text !== "string") text = String(text || "");
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(36);
}

let snippetSaveTimeout = null;
function saveSnippetCacheDebounced() {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
  if (snippetSaveTimeout) return;
  snippetSaveTimeout = setTimeout(async () => {
    snippetSaveTimeout = null;
    try {
      // Bound persisted cache to 150 items (< 15KB footprint)
      const entries = Array.from(classificationCache.entries()).slice(-150);
      await chrome.storage.local.set({ domCleanerSnippetCache: entries });
    } catch (_) {}
  }, 1500);
}

function cacheResult(text, result) {
  const key = hashText(text);
  if (classificationCache.has(key)) {
    classificationCache.delete(key);
  } else if (classificationCache.size >= CACHE_MAX_SIZE) {
    const firstKey = classificationCache.keys().next().value;
    classificationCache.delete(firstKey);
  }
  classificationCache.set(key, {
    result: {
      label: result.label || "unknown",
      confidence: result.confidence || 0,
      scores: result.scores || {}
    },
    timestamp: Date.now()
  });
  saveSnippetCacheDebounced();
}

function getCachedResult(text) {
  const key = hashText(text);
  if (classificationCache.has(key)) {
    const item = classificationCache.get(key);
    if (Date.now() - item.timestamp < 30 * 60 * 1000) {
      // Re-insert to refresh LRU order
      classificationCache.delete(key);
      classificationCache.set(key, item);
      return item.result;
    }
    classificationCache.delete(key);
  }
  return null;
}

// Flush batched DOM elements to classifier.dev
async function flushBatch() {
  const batch = pendingQueue.splice(0, MAX_BATCH_SIZE);
  batchTimeout = null;

  if (batch.length === 0) return;

  const inputs = batch.map((item) => item.text);
  const headers = {
    "Content-Type": "application/json"
  };

  if (currentConfig.apiKey && currentConfig.apiKey.trim().length > 0) {
    headers["Authorization"] = `Bearer ${currentConfig.apiKey.trim()}`;
  }

  try {
    const response = await fetch(CLASSIFIER_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        inputs,
        labels: currentConfig.labels,
        instructions: currentConfig.instructions
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`classifier.dev error HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const results = data.results || [];
    const latency = (data.usage && data.usage.ms) || 0;
    const classifiedCount = (data.usage && data.usage.classifications) || inputs.length;

    currentConfig.stats.apiRequests = (currentConfig.stats.apiRequests || 0) + 1;
    currentConfig.stats.apiClassifications = (currentConfig.stats.apiClassifications || 0) + classifiedCount;
    currentConfig.stats.lastLatencyMs = latency;
    currentConfig.stats.totalLatencyMs = (currentConfig.stats.totalLatencyMs || 0) + latency;

    if (response.headers && typeof response.headers.get === "function") {
      const remaining = response.headers.get("RateLimit-Remaining") || response.headers.get("ratelimit-remaining");
      if (remaining) {
        currentConfig.stats.rateLimitRemaining = remaining;
      }
    }
    saveConfig({ stats: currentConfig.stats });

    console.log(`[DOM Cleaner Service Worker] Classified ${inputs.length} elements via classifier.dev (${latency}ms)`);

    batch.forEach((item, index) => {
      const res = results[index] || {
        label: "unknown",
        confidence: 0,
        scores: {}
      };
      cacheResult(item.text, res);
      item.resolve(res);
    });
  } catch (error) {
    console.error("[DOM Cleaner] Batch classification failed:", error);
    batch.forEach((item) => {
      item.reject(error);
    });
  }

  if (pendingQueue.length > 0) {
    batchTimeout = setTimeout(flushBatch, BATCH_DEBOUNCE_MS);
  }
}

function classifyItem(text) {
  return new Promise((resolve, reject) => {
    const cached = getCachedResult(text);
    if (cached) {
      currentConfig.stats.cacheHits = (currentConfig.stats.cacheHits || 0) + 1;
      saveConfig({ stats: currentConfig.stats });
      return resolve(cached);
    }

    pendingQueue.push({ text, resolve, reject });

    if (!batchTimeout) {
      batchTimeout = setTimeout(flushBatch, BATCH_DEBOUNCE_MS);
    } else if (pendingQueue.length >= MAX_BATCH_SIZE) {
      clearTimeout(batchTimeout);
      flushBatch();
    }
  });
}

function shouldRemoveResult(result, threshold, config = currentConfig) {
  if (!result) return false;
  const scores = result.scores || {};
  let unwantedScore = 0;
  for (const [label, score] of Object.entries(scores)) {
    const isCookie =
      label.includes("cookie") ||
      label.includes("privacy notice") ||
      label.includes("consent");

    if (isCookie && config && config.cookieBlockingEnabled === false) {
      continue;
    }

    if (
      label.includes("advertisement") ||
      label.includes("autoplay") ||
      label.includes("promotional") ||
      label.includes("intrusive") ||
      isCookie
    ) {
      unwantedScore += (typeof score === "number" ? score : 0);
    }
  }

  if (Object.keys(scores).length > 0) {
    return unwantedScore >= threshold;
  }

  const isCookie =
    result.label &&
    (result.label.includes("cookie") ||
      result.label.includes("privacy notice") ||
      result.label.includes("consent"));

  if (isCookie && config && config.cookieBlockingEnabled === false) {
    return false;
  }

  const isUnwanted =
    result.label &&
    (result.label.includes("advertisement") ||
      result.label.includes("autoplay") ||
      result.label.includes("promotional") ||
      result.label.includes("intrusive") ||
      isCookie);
  return isUnwanted && (result.confidence || 0) >= threshold;
}

/* =========================================================================
   AI Network Domain Classifier (declarativeNetRequest Dynamic Rules)
   ========================================================================= */

function extractDomain(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isIgnoredDomain(domain) {
  if (!domain) return true;
  if (domain === "localhost" || domain.endsWith(".localhost") || domain === "127.0.0.1" || domain === "::1") return true;
  if (domain === "classifier.dev" || domain.endsWith(".classifier.dev")) return true;
  if (domain.endsWith(".google.com") && (domain.startsWith("accounts.") || domain.startsWith("chrome."))) return true;
  return false;
}

function observeDomainRequest(rawUrl) {
  if (!currentConfig.enabled || !currentConfig.domainBlockingEnabled) return;

  const domain = extractDomain(rawUrl);
  if (!domain || isIgnoredDomain(domain)) return;
  if (knownDomains.has(domain) || pendingDomainSet.has(domain)) return;

  pendingDomainSet.add(domain);
  pendingDomainList.push(domain);

  if (!domainBatchTimeout) {
    domainBatchTimeout = setTimeout(flushDomainBatch, DOMAIN_BATCH_DEBOUNCE_MS);
  } else if (pendingDomainList.length >= DOMAIN_MAX_BATCH_SIZE) {
    clearTimeout(domainBatchTimeout);
    flushDomainBatch();
  }
}

async function flushDomainBatch() {
  const domains = pendingDomainList.splice(0, DOMAIN_MAX_BATCH_SIZE);
  domainBatchTimeout = null;
  domains.forEach((d) => pendingDomainSet.delete(d));

  if (domains.length === 0) return;

  const toClassify = domains.filter((d) => !knownDomains.has(d));
  if (toClassify.length === 0) return;

  const inputs = toClassify.map((d) => `Domain: ${d}`);
  const headers = { "Content-Type": "application/json" };
  if (currentConfig.apiKey && currentConfig.apiKey.trim().length > 0) {
    headers["Authorization"] = `Bearer ${currentConfig.apiKey.trim()}`;
  }

  try {
    const response = await fetch(CLASSIFIER_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        inputs,
        labels: currentConfig.domainLabels,
        instructions: currentConfig.domainInstructions
      })
    });

    if (!response.ok) {
      throw new Error(`classifier.dev HTTP ${response.status}`);
    }

    const data = await response.json();
    const results = data.results || [];
    const latency = (data.usage && data.usage.ms) || 0;
    const classifiedCount = (data.usage && data.usage.classifications) || toClassify.length;

    currentConfig.stats.apiRequests = (currentConfig.stats.apiRequests || 0) + 1;
    currentConfig.stats.apiClassifications = (currentConfig.stats.apiClassifications || 0) + classifiedCount;
    currentConfig.stats.lastLatencyMs = latency;
    currentConfig.stats.totalLatencyMs = (currentConfig.stats.totalLatencyMs || 0) + latency;

    if (response.headers && typeof response.headers.get === "function") {
      const remaining = response.headers.get("RateLimit-Remaining") || response.headers.get("ratelimit-remaining");
      if (remaining) {
        currentConfig.stats.rateLimitRemaining = remaining;
      }
    }

    const newRules = [];
    let newBlockedCount = 0;

    toClassify.forEach((domain, idx) => {
      const res = results[idx];
      if (!res) return;

      const isAdDomain =
        res.label === "advertising or tracking domain" &&
        (res.confidence || 0) >= (currentConfig.confidenceThreshold - 0.05);

      if (isAdDomain) {
        const ruleId = nextRuleId++;
        recordKnownDomain(domain, {
          status: "blocked",
          confidence: res.confidence,
          ruleId,
          timestamp: Date.now()
        });

        newRules.push({
          id: ruleId,
          priority: 1,
          action: { type: "block" },
          condition: {
            urlFilter: `||${domain}^`,
            resourceTypes: [
              "sub_frame",
              "stylesheet",
              "script",
              "image",
              "font",
              "object",
              "xmlhttprequest",
              "ping",
              "media",
              "websocket",
              "other"
            ]
          }
        });

        newBlockedCount++;
        console.log(`[DOM Cleaner] AI Network Blocker: Blocked domain "${domain}" (confidence: ${Math.round((res.confidence || 0) * 100)}%)`);
      } else {
        recordKnownDomain(domain, {
          status: "allowed",
          confidence: res.confidence,
          timestamp: Date.now()
        });
      }
    });

    if (newRules.length > 0 && typeof chrome !== "undefined" && chrome.declarativeNetRequest) {
      await chrome.declarativeNetRequest.updateDynamicRules({ addRules: newRules });
      currentConfig.stats.domainsBlocked = (currentConfig.stats.domainsBlocked || 0) + newBlockedCount;
    }
    saveConfig({ stats: currentConfig.stats }, false);

    await saveDomainRules();
  } catch (err) {
    console.warn("[DOM Cleaner] Failed to classify domains:", err);
  }

  if (pendingDomainList.length > 0) {
    domainBatchTimeout = setTimeout(flushDomainBatch, DOMAIN_BATCH_DEBOUNCE_MS);
  }
}

// Reset dynamic network blocking rules
async function resetDynamicRules() {
  if (typeof chrome !== "undefined" && chrome.declarativeNetRequest) {
    try {
      const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
      const ruleIds = existingRules.map((r) => r.id);
      if (ruleIds.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ruleIds });
      }
    } catch (err) {
      console.warn("[DOM Cleaner] Failed to clear dynamic rules:", err);
    }
  }
  knownDomains.clear();
  nextRuleId = 1;
  await saveDomainRules();
}

// Observe outgoing requests via webRequest to catch third-party domains
if (typeof chrome !== "undefined" && chrome.webRequest && chrome.webRequest.onBeforeRequest) {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      observeDomainRequest(details.url);
    },
    { urls: ["<all_urls>"] }
  );
}

// Listen for messages from content script or popup
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { action, payload } = message;

    if (action === "GET_CONFIG") {
      storageInitPromise.then(() => {
        sendResponse({ config: currentConfig });
      });
      return true;
    }

    if (action === "SET_CONFIG") {
      saveConfig(payload, true).then(() => {
        sendResponse({ success: true, config: currentConfig });
      });
      return true;
    }

    if (action === "RESET_RULES") {
      resetDynamicRules().then(() => {
        currentConfig.stats.domainsBlocked = 0;
        currentConfig.stats.apiRequests = 0;
        currentConfig.stats.apiClassifications = 0;
        currentConfig.stats.cacheHits = 0;
        currentConfig.stats.lastLatencyMs = 0;
        currentConfig.stats.totalLatencyMs = 0;
        currentConfig.stats.totalScanned = 0;
        currentConfig.stats.adsRemoved = 0;
        currentConfig.stats.autoplayRemoved = 0;
        currentConfig.stats.cookiesBlocked = 0;
        saveConfig({ stats: currentConfig.stats }, true).then(() => {
          sendResponse({ success: true });
        });
      });
      return true;
    }

    if (action === "INCREMENT_STATS") {
      storageInitPromise.then(() => {
        const { type, count } = payload;
        if (type === "ad") {
          currentConfig.stats.adsRemoved = (currentConfig.stats.adsRemoved || 0) + (count || 1);
        } else if (type === "autoplay") {
          currentConfig.stats.autoplayRemoved = (currentConfig.stats.autoplayRemoved || 0) + (count || 1);
        } else if (type === "cookie") {
          currentConfig.stats.cookiesBlocked = (currentConfig.stats.cookiesBlocked || 0) + (count || 1);
        }
        currentConfig.stats.totalScanned = (currentConfig.stats.totalScanned || 0) + (count || 1);
        saveConfig({ stats: currentConfig.stats }, false);
        sendResponse({ success: true, stats: currentConfig.stats });
      });
      return true;
    }

    if (action === "CLASSIFY_ELEMENTS") {
      storageInitPromise.then(() => {
        if (!currentConfig.enabled) {
          sendResponse({ results: [] });
          return;
        }

        const { elements } = payload;
        if (!Array.isArray(elements) || elements.length === 0) {
          sendResponse({ results: [] });
          return;
        }

        currentConfig.stats.totalScanned = (currentConfig.stats.totalScanned || 0) + elements.length;
        saveConfig({ stats: currentConfig.stats }, false);

        const promises = elements.map(async (el) => {
          try {
            const result = await classifyItem(el.text);
            return {
              id: el.id,
              result,
              shouldRemove: shouldRemoveResult(result, currentConfig.confidenceThreshold)
            };
          } catch (err) {
            return {
              id: el.id,
              result: { label: "error", confidence: 0 },
              shouldRemove: false,
              error: err.message
            };
          }
        });

        Promise.all(promises).then((results) => {
          sendResponse({ results });
        });
      });

      return true;
    }
  });
}

// Export for unit tests
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DEFAULT_CONFIG,
    hashText,
    cacheResult,
    getCachedResult,
    classificationCache,
    classifyItem,
    flushBatch,
    shouldRemoveResult,
    extractDomain,
    isIgnoredDomain,
    observeDomainRequest,
    flushDomainBatch,
    knownDomains,
    recordKnownDomain,
    resetDynamicRules,
    currentConfig,
    saveConfig,
    CACHE_MAX_SIZE,
    DOMAIN_MAX_CACHE_SIZE
  };
}
