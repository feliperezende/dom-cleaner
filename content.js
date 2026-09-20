/**
 * Content Script for DOM Cleaner
 * Scans DOM candidates, extracts metadata snippets, queries background classifier, and removes ads/autoplay videos.
 */

if (typeof window !== "undefined" && typeof console !== "undefined") {
  if (window.self === window.top) {
    console.log(
      "%c[DOM Cleaner]%c Content script loaded on " + (window.location ? window.location.hostname : "webpage"),
      "background: #2563eb; color: #fff; font-weight: bold; padding: 2px 6px; border-radius: 3px;",
      "color: #0284c7; font-weight: bold; margin-left: 4px;"
    );
  }
}

const SCANNED_ATTR = "data-dc-scanned";
const ID_ATTR = "data-dc-id";
const SCAN_DEBOUNCE_MS = 400;

// Regular expressions for targeted heuristics (including Brazilian / Portuguese patterns)
const SUSPICIOUS_CLASS_OR_ID_REGEX = /\b(ad|ads|adunit|advert|advertisement|banner|commercial|promoted|sponsor|sponsored|taboola|outbrain|floating-player|video-slider|outstream|publicidade|publi|anuncio|anuncios|patrocinado|patrocinada|patrocinador|uolads)\b/i;
const COOKIE_CONSENT_REGEX = /\b(cookie|cookies|consent|lgpd|gdpr|onetrust|didomi|cookiebot|usercentrics|klaro|privacy-banner|cookie-banner|cookie-notice|cookie-dialog|cookie-modal|aviso-cookies|termos-privacidade|cmp-container|cmpbox)\b/i;
const AD_IFRAME_SRC_REGEX = /(doubleclick|googlesyndication|adsystem|adnxs|taboola|outbrain|criteo|rubiconproject|pubmatic|moatads|uolads)/i;

// Tags that should never be removed wholesale
const PROTECTED_TAGS = new Set([
  "HTML", "HEAD", "BODY", "MAIN", "NAV", "HEADER", "FOOTER", "ARTICLE", "SECTION", "FORM"
]);

// Optimized scoped query selector with native :not([data-dc-scanned]) filter
const SELECTOR_TOKENS = [
  "video",
  "iframe",
  '[class*="ad-"]', '[class*="ads-"]', '[id*="ad-"]', '[id*="ads-"]',
  '[class*="sponsor"]', '[class*="banner"]', '[class*="promoted"]',
  '[class*="taboola"]', '[class*="outbrain"]', '[class*="publicidade"]',
  '[id*="publicidade"]', '[class*="patrocinad"]', '[id*="patrocinad"]',
  '[class*="anuncio"]', '[id*="anuncio"]', '[class*="uolads"]', '[id*="uolads"]',
  '[class*="cookie"]', '[id*="cookie"]', '[class*="consent"]', '[id*="consent"]',
  '[class*="lgpd"]', '[id*="lgpd"]', '[class*="gdpr"]', '[id*="gdpr"]',
  '[class*="onetrust"]', '[id*="onetrust"]', '[id*="didomi"]', '[class*="didomi"]',
  '[id*="cookiebot"]', '[class*="cookiebot"]', '[class*="usercentrics"]', '[id*="usercentrics"]',
  '[role="dialog"]',
  '[role="region"][aria-label*="advertisement" i]',
  '[role="region"][aria-label*="publicidade" i]',
  '[role="dialog"][aria-label*="cookie" i]'
];
const CANDIDATE_SELECTOR = SELECTOR_TOKENS.map((s) => `${s}:not([${SCANNED_ATTR}])`).join(", ");

/**
 * 0ms Instant Fast-Path: Detect deterministic ads and CMP banners without cloud API
 */
function isDeterministicUnwanted(element, config = null) {
  if (!element || (typeof Node !== "undefined" && element.nodeType !== Node.ELEMENT_NODE)) return null;
  const tagName = (element.tagName || "").toUpperCase();
  if (PROTECTED_TAGS.has(tagName)) return null;

  // 1. Known ad network iframes
  if (tagName === "IFRAME") {
    const src = element.src || (element.getAttribute && element.getAttribute("data-src")) || "";
    if (AD_IFRAME_SRC_REGEX.test(src)) {
      return { type: "ad", label: "advertisement (known ad network iframe)" };
    }
  }

  const id = element.id || "";
  const className = typeof element.className === "string" ? element.className : "";

  // 2. Cookie consent banners (e.g. OneTrust, Didomi, Cookiebot, LGPD)
  if (!config || config.cookieBlockingEnabled !== false) {
    if (COOKIE_CONSENT_REGEX.test(id) || COOKIE_CONSENT_REGEX.test(className)) {
      return { type: "cookie", label: "cookie consent or privacy notice modal" };
    }
  }

  // 3. Unambiguous third-party ad widgets
  if (/(taboola|outbrain|uolads)/i.test(id) || /(taboola|outbrain|uolads)/i.test(className)) {
    return { type: "ad", label: "advertisement (known ad provider)" };
  }

  return null;
}

/**
 * Determine whether an element is a candidate for classification
 */
function isCandidateElement(element) {
  if (!element || (typeof Node !== "undefined" && element.nodeType !== Node.ELEMENT_NODE)) return false;
  if (element.hasAttribute && element.hasAttribute(SCANNED_ATTR)) return false;

  const tagName = (element.tagName || "").toUpperCase();
  if (PROTECTED_TAGS.has(tagName)) return false;

  // 1. Video candidates (autoplay / muted / outstream)
  if (tagName === "VIDEO") {
    const isAutoplay = element.autoplay || (element.hasAttribute && element.hasAttribute("autoplay"));
    const isMuted = element.muted || (element.hasAttribute && element.hasAttribute("muted"));
    const isPlaying = !element.paused && element.currentTime > 0;
    if (isAutoplay || isMuted || isPlaying) {
      return true;
    }
  }

  // 2. Iframe candidates
  if (tagName === "IFRAME") {
    const src = element.src || (element.getAttribute && element.getAttribute("data-src")) || "";
    const id = element.id || "";
    const className = typeof element.className === "string" ? element.className : "";
    if (
      AD_IFRAME_SRC_REGEX.test(src) ||
      SUSPICIOUS_CLASS_OR_ID_REGEX.test(id) ||
      SUSPICIOUS_CLASS_OR_ID_REGEX.test(className) ||
      COOKIE_CONSENT_REGEX.test(id) ||
      COOKIE_CONSENT_REGEX.test(className)
    ) {
      return true;
    }
  }

  // 3. Elements with suspicious classes, IDs, or aria attributes (Ads & Cookie Banners)
  const id = element.id || "";
  const className = typeof element.className === "string" ? element.className : "";
  const ariaLabel = (element.getAttribute && element.getAttribute("aria-label")) || "";
  const role = (element.getAttribute && element.getAttribute("role")) || "";

  if (
    SUSPICIOUS_CLASS_OR_ID_REGEX.test(id) ||
    SUSPICIOUS_CLASS_OR_ID_REGEX.test(className) ||
    SUSPICIOUS_CLASS_OR_ID_REGEX.test(ariaLabel) ||
    COOKIE_CONSENT_REGEX.test(id) ||
    COOKIE_CONSENT_REGEX.test(className) ||
    COOKIE_CONSENT_REGEX.test(ariaLabel) ||
    ((role === "region" || role === "dialog") && (SUSPICIOUS_CLASS_OR_ID_REGEX.test(ariaLabel) || COOKIE_CONSENT_REGEX.test(ariaLabel)))
  ) {
    return true;
  }

  // 4. Floating / fixed position video containers (gated to avoid forced reflows on general elements)
  const styleAttr = (element.getAttribute && element.getAttribute("style")) || "";
  const hasFloatingHint = /fixed|sticky/i.test(styleAttr) || /\b(floating|overlay|modal|sticky-banner)\b/i.test(className);
  if (hasFloatingHint && typeof window !== "undefined" && window.getComputedStyle) {
    try {
      const computed = window.getComputedStyle(element);
      if (computed.position === "fixed" || computed.position === "sticky") {
        if (element.querySelector && element.querySelector("video")) {
          return true;
        }
      }
    } catch (_) {}
  }

  return false;
}

/**
 * Extract formatted text and metadata snippet for classifier.dev
 * Uses textContent to eliminate forced synchronous reflows (innerText)
 */
function extractElementSnippet(element) {
  const tagName = (element.tagName || "").toUpperCase();
  const id = (element.id || "").trim();
  const className = (typeof element.className === "string" ? element.className : "").trim().slice(0, 100);
  const ariaLabel = ((element.getAttribute && element.getAttribute("aria-label")) || "").trim();
  const role = ((element.getAttribute && element.getAttribute("role")) || "").trim();

  // textContent avoids layout reflow while falling back to innerText for mocks
  let textContent = (element.textContent || element.innerText || "").replace(/\s+/g, " ").trim();
  if (textContent.length > 200) {
    textContent = textContent.slice(0, 200) + "...";
  }

  let extraMeta = [];

  if (tagName === "VIDEO") {
    const isAutoplay = element.autoplay || (element.hasAttribute && element.hasAttribute("autoplay"));
    const isMuted = element.muted || (element.hasAttribute && element.hasAttribute("muted"));
    extraMeta.push(`autoplay=${!!isAutoplay}`, `muted=${!!isMuted}`);
    const src = element.currentSrc || element.src || "";
    if (src) extraMeta.push(`src=${src.slice(0, 80)}`);
  } else if (tagName === "IFRAME") {
    const src = element.src || (element.getAttribute && element.getAttribute("data-src")) || "";
    if (src) extraMeta.push(`iframeSrc=${src.slice(0, 100)}`);
  }

  const parts = [
    `[TAG: ${tagName}]`,
    id ? `[ID: ${id}]` : null,
    className ? `[CLASS: ${className}]` : null,
    ariaLabel ? `[ARIA: ${ariaLabel}]` : null,
    role ? `[ROLE: ${role}]` : null,
    extraMeta.length > 0 ? `[META: ${extraMeta.join(", ")}]` : null,
    textContent ? `[TEXT: ${textContent}]` : null
  ].filter(Boolean);

  return parts.join(" ");
}

/**
 * Restore scrolling when a modal or cookie banner locked document scroll
 */
function unlockPageScroll() {
  if (typeof document === "undefined") return;
  const targets = [document.documentElement, document.body];
  targets.forEach((el) => {
    if (!el) return;
    if (el.style) {
      if (el.style.overflow === "hidden") el.style.overflow = "";
      if (el.style.position === "fixed") el.style.position = "";
    }
    if (el.classList) {
      el.classList.remove(
        "modal-open",
        "no-scroll",
        "cookie-modal-open",
        "ot-no-scroll",
        "didomi-popup-open"
      );
    }
  });

  const overlays = document.querySelectorAll(
    '.onetrust-pc-dark-filter, #onetrust-consent-sdk .onetrust-pc-dark-filter, .didomi-popup-backdrop, .cookie-backdrop, [class*="cookie-overlay"], [id*="cookie-overlay"], [class*="consent-backdrop"]'
  );
  overlays.forEach((overlay) => {
    try { overlay.remove(); } catch (_) {}
  });
}

/**
 * Remove element from DOM, finding sensible top-level ad wrapper if present
 */
function removeElement(element, label) {
  if (!element || !element.parentNode) return;

  // Check if parent is a dedicated ad container wrapper (e.g. single child in an ad wrapper)
  let targetToRemove = element;
  const parent = element.parentElement;
  if (
    parent &&
    !PROTECTED_TAGS.has((parent.tagName || "").toUpperCase()) &&
    parent.children &&
    parent.children.length === 1 &&
    (SUSPICIOUS_CLASS_OR_ID_REGEX.test(parent.className || parent.id || "") ||
     COOKIE_CONSENT_REGEX.test(parent.className || parent.id || ""))
  ) {
    targetToRemove = parent;
  }

  try {
    // Pause any active media before detaching
    if (targetToRemove.tagName === "VIDEO" && typeof targetToRemove.pause === "function") {
      targetToRemove.pause();
      targetToRemove.src = "";
    }
    const internalVideos = targetToRemove.querySelectorAll ? targetToRemove.querySelectorAll("video") : [];
    internalVideos.forEach((v) => {
      try {
        if (typeof v.pause === "function") v.pause();
        v.src = "";
      } catch (_) {}
    });

    if (typeof targetToRemove.remove === "function") {
      targetToRemove.remove();
    } else if (targetToRemove.parentNode) {
      targetToRemove.parentNode.removeChild(targetToRemove);
    }

    console.log(`[DOM Cleaner] Removed element (${label || "unwanted"}):`, targetToRemove);

    // Notify background to increment stats
    const isAutoplay = label && label.includes("autoplay");
    const isCookie = label && (label.includes("cookie") || label.includes("privacy notice") || label.includes("consent"));
    if (isCookie) {
      unlockPageScroll();
    }

    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        action: "INCREMENT_STATS",
        payload: {
          type: isCookie ? "cookie" : (isAutoplay ? "autoplay" : "ad"),
          count: 1
        }
      });
    }
  } catch (err) {
    console.warn("[DOM Cleaner] Failed to remove element:", err);
  }
}

/**
 * Content Script Runtime Initialization
 */
function initContentScript() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  // Ignore subframes/iframes to avoid duplicate work and redundant requests
  if (window.self !== window.top) return;
  if (window.__DOM_CLEANER_INITIALIZED__) return;
  window.__DOM_CLEANER_INITIALIZED__ = true;

  console.log(`[DOM Cleaner] Active on ${window.location.hostname}`);

  let candidateCounter = 0;
  let scanTimeout = null;
  const pendingCandidates = new Map(); // id -> Element
  const pendingNodesToScan = new Set();

  let contentConfig = { enabled: true, cookieBlockingEnabled: true };
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
    chrome.runtime.sendMessage({ action: "GET_CONFIG" }, (res) => {
      if (res && res.config) {
        contentConfig.enabled = res.config.enabled !== false;
        contentConfig.cookieBlockingEnabled = res.config.cookieBlockingEnabled !== false;
      }
    });
  }
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.domCleanerConfig && changes.domCleanerConfig.newValue) {
        const cfg = changes.domCleanerConfig.newValue;
        contentConfig.enabled = cfg.enabled !== false;
        contentConfig.cookieBlockingEnabled = cfg.cookieBlockingEnabled !== false;
      }
    });
  }

  function collectCandidatesFromNode(rootNode) {
    if (!rootNode || !rootNode.querySelectorAll) return [];
    const candidates = [];
    if (isCandidateElement(rootNode)) {
      candidates.push(rootNode);
    }
    try {
      const matches = rootNode.querySelectorAll(CANDIDATE_SELECTOR);
      for (let i = 0; i < matches.length; i++) {
        const el = matches[i];
        if (isCandidateElement(el)) {
          candidates.push(el);
        }
      }
    } catch (_) {}
    return candidates;
  }

  function processPendingCandidates(callback = null) {
    scanTimeout = null;
    if (contentConfig.enabled === false) {
      pendingNodesToScan.clear();
      if (typeof callback === "function") callback({ candidates: 0, removed: 0 });
      return;
    }

    let candidates = [];
    if (pendingNodesToScan.size > 0) {
      for (const node of pendingNodesToScan) {
        if (node && node.isConnected !== false) {
          candidates.push(...collectCandidatesFromNode(node));
        }
      }
      pendingNodesToScan.clear();
    } else if (document.body) {
      candidates = collectCandidatesFromNode(document.body);
    }

    if (!candidates || candidates.length === 0) {
      if (typeof callback === "function") callback({ candidates: 0, removed: 0 });
      return;
    }

    const payloadElements = [];
    let fastRemovedCount = 0;

    candidates.forEach((el) => {
      if (el.hasAttribute && el.hasAttribute(SCANNED_ATTR)) return;
      el.setAttribute(SCANNED_ATTR, "true");

      // Fast-path: 0ms instant local removal for deterministic ads & cookie banners
      const deterministic = isDeterministicUnwanted(el, contentConfig);
      if (deterministic) {
        removeElement(el, deterministic.label);
        fastRemovedCount++;
        return;
      }

      // Slow-path: route to classifier.dev for ambiguous items
      candidateCounter += 1;
      const id = String(candidateCounter);
      el.setAttribute(ID_ATTR, id);
      pendingCandidates.set(id, el);

      const snippet = extractElementSnippet(el);
      payloadElements.push({ id, text: snippet });
    });

    if (payloadElements.length === 0) {
      if (typeof callback === "function") callback({ candidates: candidates.length, removed: fastRemovedCount });
      return;
    }

    // Prune pendingCandidates after 15s to prevent detached DOM leaks if request drops
    const queuedIds = payloadElements.map((p) => p.id);
    setTimeout(() => {
      queuedIds.forEach((id) => pendingCandidates.delete(id));
    }, 15000);

    console.log(`[DOM Cleaner] Evaluating ${payloadElements.length} candidate elements via classifier.dev...`);

    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage(
        {
          action: "CLASSIFY_ELEMENTS",
          payload: { elements: payloadElements }
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn("[DOM Cleaner] Background worker error:", chrome.runtime.lastError.message);
            queuedIds.forEach((id) => pendingCandidates.delete(id));
            if (typeof callback === "function") callback({ candidates: candidates.length, removed: fastRemovedCount });
            return;
          }
          if (!response || !response.results) {
            queuedIds.forEach((id) => pendingCandidates.delete(id));
            if (typeof callback === "function") callback({ candidates: candidates.length, removed: fastRemovedCount });
            return;
          }

          let slowRemovedCount = 0;
          response.results.forEach(({ id, result, shouldRemove }) => {
            const targetEl = pendingCandidates.get(id) || document.querySelector(`[${ID_ATTR}="${id}"]`);
            pendingCandidates.delete(id); // Immediate reference release for GC
            if (targetEl) {
              if (shouldRemove) {
                slowRemovedCount++;
                console.log(`[DOM Cleaner] Match found: "${result.label}" (confidence: ${Math.round((result.confidence || 0) * 100)}%)`);
                removeElement(targetEl, result.label);
              } else {
                targetEl.removeAttribute(ID_ATTR);
              }
            }
          });

          if (typeof callback === "function") {
            callback({ candidates: candidates.length, removed: fastRemovedCount + slowRemovedCount });
          }
        }
      );
    } else {
      if (typeof callback === "function") callback({ candidates: candidates.length, removed: fastRemovedCount });
    }
  }

  function scheduleScan(targetNode = null) {
    if (targetNode) {
      pendingNodesToScan.add(targetNode);
    }
    if (scanTimeout) clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => processPendingCandidates(), SCAN_DEBOUNCE_MS);
  }

  const observer = new MutationObserver((mutations) => {
    let shouldScan = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes && mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1 /* Node.ELEMENT_NODE */) {
            pendingNodesToScan.add(node);
            shouldScan = true;
          }
        }
      }
    }

    if (shouldScan) {
      scheduleScan();
    }
  });

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    scheduleScan(document.body);
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
      scheduleScan(document.body);
    });
  }

  document.addEventListener(
    "play",
    (event) => {
      const target = event.target;
      if (target && target.tagName === "VIDEO" && !target.hasAttribute(SCANNED_ATTR)) {
        if (isCandidateElement(target)) {
          scheduleScan(target);
        }
      }
    },
    true
  );

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.action === "FORCE_SCAN") {
        if (scanTimeout) {
          clearTimeout(scanTimeout);
          scanTimeout = null;
        }
        pendingNodesToScan.clear();
        const previousScanned = document.querySelectorAll(`[${SCANNED_ATTR}]`);
        previousScanned.forEach((el) => {
          el.removeAttribute(SCANNED_ATTR);
          el.removeAttribute(ID_ATTR);
        });

        processPendingCandidates((stats) => {
          sendResponse({ success: true, ...stats });
        });
        return true; // Keep message channel open for async sendResponse
      }
    });
  }
}

// Auto-run when in browser
initContentScript();

// Export helpers for testing
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    isCandidateElement,
    isDeterministicUnwanted,
    extractElementSnippet,
    removeElement,
    unlockPageScroll,
    SUSPICIOUS_CLASS_OR_ID_REGEX,
    COOKIE_CONSENT_REGEX,
    AD_IFRAME_SRC_REGEX,
    PROTECTED_TAGS
  };
}
