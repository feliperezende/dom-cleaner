/**
 * Popup Script for DOM Cleaner
 * Manages user preferences, statistics display, and interaction with background worker.
 */

document.addEventListener("DOMContentLoaded", () => {
  const enabledToggle = document.getElementById("enabled-toggle");
  const statusCard = document.getElementById("status-card");
  const statusText = document.getElementById("status-text");

  const statAds = document.getElementById("stat-ads");
  const statAutoplay = document.getElementById("stat-autoplay");
  const statCookies = document.getElementById("stat-cookies");
  const statDomains = document.getElementById("stat-domains");
  const statScanned = document.getElementById("stat-scanned");

  const apiTierBadge = document.getElementById("api-tier-badge");
  const apiCalls = document.getElementById("api-calls");
  const apiCached = document.getElementById("api-cached");
  const apiLatency = document.getElementById("api-latency");
  const apiQuota = document.getElementById("api-quota");

  const cookieBlockingToggle = document.getElementById("cookie-blocking-toggle");
  const domainBlockingToggle = document.getElementById("domain-blocking-toggle");

  const thresholdSlider = document.getElementById("threshold-slider");
  const thresholdVal = document.getElementById("threshold-val");

  const apiKeyInput = document.getElementById("api-key-input");
  const toggleKeyBtn = document.getElementById("toggle-key-btn");

  const rescanBtn = document.getElementById("rescan-btn");
  const resetStatsBtn = document.getElementById("reset-stats-btn");

  let debounceTimer = null;

  // Update visual status banner
  function updateStatus(enabled) {
    if (enabled) {
      statusCard.classList.remove("disabled");
      statusText.textContent = "Protection Active";
    } else {
      statusCard.classList.add("disabled");
      statusText.textContent = "Protection Paused";
    }
  }

  // Load current configuration and stats
  function loadConfig() {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ action: "GET_CONFIG" }, (response) => {
        if (!response || !response.config) return;
        const cfg = response.config;

        enabledToggle.checked = !!cfg.enabled;
        updateStatus(!!cfg.enabled);

        if (cookieBlockingToggle) {
          cookieBlockingToggle.checked = cfg.cookieBlockingEnabled !== false;
        }

        if (domainBlockingToggle) {
          domainBlockingToggle.checked = cfg.domainBlockingEnabled !== false;
        }

        const pct = Math.round((cfg.confidenceThreshold || 0.75) * 100);
        thresholdSlider.value = pct;
        thresholdVal.textContent = `${pct}%`;

        apiKeyInput.value = cfg.apiKey || "";

        const stats = cfg.stats || {};
        statAds.textContent = (stats.adsRemoved || 0).toLocaleString();
        statAutoplay.textContent = (stats.autoplayRemoved || 0).toLocaleString();
        if (statCookies) {
          statCookies.textContent = (stats.cookiesBlocked || 0).toLocaleString();
        }
        if (statDomains) {
          statDomains.textContent = (stats.domainsBlocked || 0).toLocaleString();
        }
        statScanned.textContent = (stats.totalScanned || 0).toLocaleString();

        // classifier.dev usage metrics
        if (apiCalls) {
          apiCalls.textContent = (stats.apiClassifications || 0).toLocaleString();
        }
        if (apiCached) {
          apiCached.textContent = (stats.cacheHits || 0).toLocaleString();
        }
        if (apiLatency) {
          const avgMs = stats.apiRequests > 0
            ? Math.round((stats.totalLatencyMs || 0) / stats.apiRequests)
            : (stats.lastLatencyMs || 0);
          apiLatency.textContent = `${avgMs}ms`;
        }
        if (apiTierBadge) {
          if (cfg.apiKey && cfg.apiKey.trim().length > 0) {
            apiTierBadge.textContent = "Pro Tier";
            apiTierBadge.classList.add("badge-pro");
          } else {
            apiTierBadge.textContent = "Free Tier";
            apiTierBadge.classList.remove("badge-pro");
          }
        }
        if (apiQuota) {
          if (stats.rateLimitRemaining) {
            apiQuota.textContent = `${stats.rateLimitRemaining}/m`;
          } else {
            apiQuota.textContent = "Active";
          }
        }
      });
    }
  }

  // Save partial config to background
  function saveConfig(partial) {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ action: "SET_CONFIG", payload: partial });
    }
  }

  // Event: Toggle Enable / Disable
  enabledToggle.addEventListener("change", () => {
    const isEnabled = enabledToggle.checked;
    updateStatus(isEnabled);
    saveConfig({ enabled: isEnabled });
  });

  // Event: Toggle Cookie Blocking
  if (cookieBlockingToggle) {
    cookieBlockingToggle.addEventListener("change", () => {
      saveConfig({ cookieBlockingEnabled: cookieBlockingToggle.checked });
    });
  }

  // Event: Toggle Domain Blocking
  if (domainBlockingToggle) {
    domainBlockingToggle.addEventListener("change", () => {
      saveConfig({ domainBlockingEnabled: domainBlockingToggle.checked });
    });
  }

  // Event: Threshold slider change
  thresholdSlider.addEventListener("input", () => {
    const pct = parseInt(thresholdSlider.value, 10);
    thresholdVal.textContent = `${pct}%`;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      saveConfig({ confidenceThreshold: pct / 100 });
    }, 200);
  });

  // Event: API Key change
  apiKeyInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      saveConfig({ apiKey: apiKeyInput.value.trim() });
    }, 400);
  });

  // Toggle API Key visibility
  toggleKeyBtn.addEventListener("click", () => {
    if (apiKeyInput.type === "password") {
      apiKeyInput.type = "text";
      toggleKeyBtn.textContent = "🔒";
    } else {
      apiKeyInput.type = "password";
      toggleKeyBtn.textContent = "👁️";
    }
  });

  // Event: Force Scan Active Tab
  rescanBtn.addEventListener("click", () => {
    if (typeof chrome === "undefined" || !chrome.tabs) return;

    rescanBtn.textContent = "Scanning...";
    rescanBtn.disabled = true;

    function resetBtn(delay = 1800) {
      setTimeout(() => {
        rescanBtn.textContent = "Scan Active Tab";
        rescanBtn.disabled = false;
      }, delay);
    }

    function triggerScan(tab) {
      if (!tab || !tab.id) {
        rescanBtn.textContent = "No active tab found";
        resetBtn();
        return;
      }

      const url = tab.url || "";
      if (
        url.startsWith("chrome://") ||
        url.startsWith("edge://") ||
        url.startsWith("about:") ||
        url.startsWith("chrome-extension://") ||
        url.startsWith("view-source:") ||
        url.startsWith("devtools://")
      ) {
        rescanBtn.textContent = "Cannot scan browser page";
        resetBtn();
        return;
      }

      function handleScanResult(res) {
        loadConfig();
        if (res && res.success) {
          if (res.removed > 0) {
            rescanBtn.textContent = `Cleaned ${res.removed} unwanted item${res.removed > 1 ? "s" : ""}!`;
          } else if (res.candidates > 0) {
            rescanBtn.textContent = `Scanned ${res.candidates} items (safe)`;
          } else {
            rescanBtn.textContent = "Page is clean (0 ads found)";
          }
        } else {
          rescanBtn.textContent = "Scan completed";
        }
        resetBtn();
      }

      chrome.tabs.sendMessage(tab.id, { action: "FORCE_SCAN" }, (response) => {
        if (chrome.runtime.lastError) {
          // Content script not injected yet, inject it dynamically
          if (chrome.scripting && chrome.scripting.executeScript) {
            chrome.scripting.executeScript(
              {
                target: { tabId: tab.id },
                files: ["content.js"]
              },
              () => {
                if (chrome.runtime.lastError) {
                  rescanBtn.textContent = "Scan unavailable on this tab";
                  resetBtn();
                  return;
                }
                setTimeout(() => {
                  chrome.tabs.sendMessage(tab.id, { action: "FORCE_SCAN" }, (res2) => {
                    if (chrome.runtime.lastError) {
                      rescanBtn.textContent = "Connection error";
                      resetBtn();
                      return;
                    }
                    handleScanResult(res2);
                  });
                }, 100);
              }
            );
          } else {
            rescanBtn.textContent = "Failed to connect";
            resetBtn();
          }
          return;
        }

        handleScanResult(response);
      });
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      let tab = tabs && tabs[0];
      if (!tab) {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, (fallbackTabs) => {
          triggerScan(fallbackTabs && fallbackTabs[0]);
        });
      } else {
        triggerScan(tab);
      }
    });
  });

  // Event: Reset Stats
  resetStatsBtn.addEventListener("click", () => {
    const resetStats = {
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
    };
    saveConfig({ stats: resetStats });
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ action: "RESET_RULES" });
    }
    statAds.textContent = "0";
    statAutoplay.textContent = "0";
    if (statCookies) statCookies.textContent = "0";
    if (statDomains) statDomains.textContent = "0";
    statScanned.textContent = "0";
    if (apiCalls) apiCalls.textContent = "0";
    if (apiCached) apiCached.textContent = "0";
    if (apiLatency) apiLatency.textContent = "0ms";
    if (apiQuota) apiQuota.textContent = "Active";
  });

  // Listen for storage changes in real time while popup is open (event-driven, zero polling)
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.domCleanerConfig) {
        loadConfig();
      }
    });
  }

  loadConfig();
});
