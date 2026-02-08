import { CONFIG } from "./config.js";
import { STATIC_ITEM_DATA } from "./data/static-item-data.js";

const CACHE_KEY = "historyData_restock_v2";
const REFRESH_LOCK_KEY = `${CACHE_KEY}:refresh-lock`;
const REFRESH_LOCK_TTL_MS = 5 * 60 * 1000;
const WAIT_FOR_CACHE_UPDATE_MS = 8000;

function nowMs() {
  return Date.now();
}

function getCacheRecord(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getCachedData(key) {
  const rec = getCacheRecord(key);
  if (!rec) return null;
  const age = nowMs() - rec.timestamp;
  if (age > CONFIG.CACHE_DURATION) {
    try {
      localStorage.removeItem(key);
    } catch { }
    return null;
  }
  return rec.data;
}

function setCachedData(key, data) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        data,
        timestamp: nowMs(),
      })
    );
  } catch { }
}

function getCacheAge(key) {
  const rec = getCacheRecord(key);
  if (!rec) return null;
  return nowMs() - rec.timestamp;
}

function tryAcquireRefreshLock() {
  const existing = getCacheRecord(REFRESH_LOCK_KEY);
  const current = nowMs();
  if (existing && typeof existing.timestamp === "number") {
    if (current - existing.timestamp < REFRESH_LOCK_TTL_MS) {
      return false;
    }
  }

  try {
    localStorage.setItem(
      REFRESH_LOCK_KEY,
      JSON.stringify({ timestamp: current, id: `${current}-${Math.random()}` })
    );
    return true;
  } catch {
    return false;
  }
}

function releaseRefreshLock() {
  try {
    localStorage.removeItem(REFRESH_LOCK_KEY);
  } catch { }
}

function waitForCacheUpdate() {
  return new Promise((resolve) => {
    const start = nowMs();
    const tick = () => {
      const cached = getCachedData(CACHE_KEY);
      if (cached && cached.items && cached.items.length > 0) {
        resolve(cached);
        return;
      }
      if (nowMs() - start > WAIT_FOR_CACHE_UPDATE_MS) {
        resolve(null);
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

// === State ===
let historyData = [];
let trackedItems = new Set();
let currentFilter = "all";
let currentSearch = "";
let sortColumn = null;
let sortDirection = "asc";
let lastFetchTime = 0;
let isFetching = false;
let retryCount = 0;

// === Sprites ===
function getSpriteUrl(itemId, shopType) {
  if (shopType === "seed") {
    if (itemId === "OrangeTulip") return `https://mg-api.ariedam.fr/assets/sprites/seeds/Tulip.png`; // Fallback to Tulip
    return `https://mg-api.ariedam.fr/assets/sprites/seeds/${itemId}.png`;
  }
  if (shopType === "egg") {
    return `https://mg-api.ariedam.fr/assets/sprites/pets/${itemId}.png`;
  }
  return null;
}

function getDecorSpriteUrl(itemId) {
  const aliases = {
    StoneBirdbath: "StoneBirdBath",
    WoodBirdhouse: "Birdhouse",
    WoodPergola: "WoodArch",
  };
  const canonical = aliases[itemId] || itemId;
  return `./decor-sprites/${canonical}.png`;
}

function applySpriteFallback(img) {
  if (!img || img.dataset.fallbackApplied) return;
  img.dataset.fallbackApplied = "1";
  img.onerror = () => {
    const fallback = img.dataset.fallbackSrc;
    if (fallback && img.src !== fallback) {
      img.src = fallback;
    }
  };
}

const prefetchedSpriteUrls = new Set();
let prefetchScrollBound = false;
let prefetchScrollRaf = null;

function getVisibleSpriteUrls() {
  const container = document.getElementById("history-table");
  if (!container) return [];
  const containerRect = container.getBoundingClientRect();
  const images = container.querySelectorAll("img.restock-item-sprite");
  const seen = new Set();
  images.forEach((img) => {
    if (!img || !img.src) return;
    const rect = img.getBoundingClientRect();
    const visible = rect.bottom >= containerRect.top && rect.top <= containerRect.bottom;
    if (visible) {
      seen.add(img.src);
    }
  });
  return Array.from(seen);
}

function prefetchVisibleSprites() {
  const urls = getVisibleSpriteUrls();
  urls.forEach((url) => {
    if (prefetchedSpriteUrls.has(url)) return;
    prefetchedSpriteUrls.add(url);
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.as = "image";
    link.href = url;
    document.head.appendChild(link);
  });
}

function bindPrefetchScroll() {
  if (prefetchScrollBound) return;
  const container = document.getElementById("history-table");
  if (!container) return;
  prefetchScrollBound = true;
  container.addEventListener("scroll", () => {
    if (prefetchScrollRaf !== null) return;
    prefetchScrollRaf = requestAnimationFrame(() => {
      prefetchScrollRaf = null;
      prefetchVisibleSprites();
    });
  });
}

// === Item meta ===
function getItemKey(itemId, shopType) {
  return `${shopType}:${itemId}`;
}

function getItemMeta(itemId, shopType) {
  return STATIC_ITEM_DATA[getItemKey(itemId, shopType)] || null;
}

function getItemName(itemId, shopType) {
  const meta = getItemMeta(itemId, shopType);
  return meta?.name || itemId;
}

function getRarity(itemId, shopType) {
  const meta = getItemMeta(itemId, shopType);
  return meta?.rarity || "common";
}

function getCoinPrice(itemId, shopType) {
  const meta = getItemMeta(itemId, shopType);
  return meta?.price || 0;
}

function getExpiryMs(itemId, shopType) {
  const meta = getItemMeta(itemId, shopType);
  return meta?.expiryMs ?? null;
}

// === Theme/UI ===
function toggleTheme() {
  document.body.classList.toggle("theme-light");
  const icon = document.getElementById("theme-icon");
  if (icon) {
    icon.textContent = document.body.classList.contains("theme-light") ? "🌙" : "☀️";
  }
  localStorage.setItem(
    "theme",
    document.body.classList.contains("theme-light") ? "light" : "dark"
  );
}

function toggleCard(header) {
  header.parentElement.classList.toggle("collapsed");
}

// expose for inline onclick in HTML
window.toggleTheme = toggleTheme;
window.toggleCard = toggleCard;

if (localStorage.getItem("theme") === "light") {
  document.body.classList.add("theme-light");
  const icon = document.getElementById("theme-icon");
  if (icon) icon.textContent = "🌙";
}

// === Data load ===
async function loadHistoryData(forceRefresh = false) {
  const timeSinceLastFetch = nowMs() - lastFetchTime;
  if (!forceRefresh && timeSinceLastFetch < CONFIG.MIN_REFRESH_INTERVAL) {
    return;
  }
  if (isFetching) return;

  if (!forceRefresh) {
    const cached = getCachedData(CACHE_KEY);
    const cacheAge = getCacheAge(CACHE_KEY);
    if (cached && cacheAge !== null && cacheAge < CONFIG.CACHE_DURATION) {
      historyData = cached.items;
      document.getElementById("status-text").textContent = `Tracking ${historyData.length} items`;
      const lastUpdated = new Date(cached.lastUpdated);
      const cacheAgeMin = Math.floor(cacheAge / 60000);
      document.getElementById("last-updated").textContent = `Last updated: ${lastUpdated.toLocaleTimeString()} (cached ${cacheAgeMin}m ago)`;
      return;
    }
  }

  const hasLock = tryAcquireRefreshLock();
  if (!hasLock) {
    const updated = await waitForCacheUpdate();
    if (updated && updated.items) {
      historyData = updated.items;
      document.getElementById("status-text").textContent = `Tracking ${historyData.length} items`;
      const lastUpdated = new Date(updated.lastUpdated ?? nowMs());
      const cacheAgeMin = Math.floor((getCacheAge(CACHE_KEY) ?? 0) / 60000);
      document.getElementById("last-updated").textContent = `Last updated: ${lastUpdated.toLocaleTimeString()} (cached ${cacheAgeMin}m ago)`;
      return;
    }
  }

  isFetching = true;
  lastFetchTime = nowMs();

  try {
    // Use the new View for server-side advanced predictions
    const predictionsUrl = CONFIG.API_URL.replace("/functions/v1/restock-history", "/rest/v1/restock_predictions?select=*");

    // Fallback if replace didn't work (e.g. config changed)
    const finalUrl = predictionsUrl.includes("restock_predictions")
      ? predictionsUrl
      : "https://xjuvryjgrjchbhjixwzh.supabase.co/rest/v1/restock_predictions?select=*";

    const response = await fetch(finalUrl, {
      headers: {
        apikey: CONFIG.API_KEY,
        "Authorization": `Bearer ${CONFIG.API_KEY}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    historyData = [];
    // The View returns an array, not { items: ... }
    if (Array.isArray(data)) {
      historyData = data.map(row => ({
        itemId: row.item_id,
        shopType: row.shop_type,
        // View columns:
        appearanceRate: row.current_probability, // The Boosted Rate
        estimatedNextTimestamp: row.estimated_next_timestamp, // The Median-based Estimate
        medianIntervalMs: row.median_interval_ms,
        lastSeen: row.last_seen,
        // Defaults/Helpers:
        totalOccurrences: 10, // Dummy to prevent UI errors
        totalQuantity: 0,
        averageIntervalMs: row.median_interval_ms, // Map median to average for fallback
      }));
    }

    setCachedData(CACHE_KEY, {
      items: historyData,
      lastUpdated: nowMs(), // View doesn't have meta yet
    });

    document.getElementById("status-text").textContent = `Tracking ${historyData.length} items`;
    const updatedAt = data.meta?.lastUpdated ? new Date(data.meta.lastUpdated) : new Date();
    document.getElementById("last-updated").textContent = `Last updated: ${updatedAt.toLocaleTimeString()}`;

    retryCount = 0;
  } catch (error) {
    console.error("Failed to load history:", error);

    const cached = getCachedData(CACHE_KEY);
    if (cached && cached.items) {
      historyData = cached.items;
      const lastUpdated = new Date(cached.lastUpdated);
      const cacheAge = getCacheAge(CACHE_KEY) ?? 0;
      const cacheAgeMin = Math.floor(cacheAge / 60000);

      document.getElementById("status-text").textContent = `⚠️ Using cached data (${historyData.length} items)`;
      document.getElementById("last-updated").textContent = `Last updated: ${lastUpdated.toLocaleTimeString()} (${cacheAgeMin}m ago)`;
    } else {
      document.getElementById("status-text").textContent = "Error loading data";
      document.getElementById("last-updated").textContent = error?.message ?? "Unknown error";
    }
  } finally {
    isFetching = false;
    releaseRefreshLock();
  }
}

// === Formatting helpers ===
function formatPrice(value) {
  if (!value || value < 1000) return `${value}`;
  const units = ["K", "M", "B", "T", "Q"];
  let v = value;
  let idx = -1;
  while (v >= 1000 && idx < units.length - 1) {
    v /= 1000;
    idx++;
  }
  const rounded = v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${rounded}${units[idx]}`;
}

function formatRelative(ms) {
  if (!ms) return "-";
  const diff = nowMs() - ms;
  if (diff < 0) return "just now";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function formatClock(ms) {
  if (!ms) return "-";
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatRelativeDay(ms) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 86400000;
  const diffDays = Math.floor(
    (startOfToday.getTime() - new Date(ms).setHours(0, 0, 0, 0)) / dayMs
  );
  if (!Number.isFinite(diffDays) || diffDays <= 0) return null;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
  return rtf.format(-diffDays, "day");
}

function formatETA(estimatedNext) {
  if (!estimatedNext) return "-";
  const diff = estimatedNext - nowMs();
  if (diff <= 0) {
    // Concise overdue message
    const ms = Math.abs(diff);
    const d = Math.floor(ms / 86400000);
    const h = Math.floor(ms / 3600000);
    if (d < 1) return `Late ${h}h`;
    return `Late ${d}d`;
  }
  const min = Math.ceil(diff / 60000);
  if (min < 60) return `~${min}m`;
  const hr = Math.ceil(min / 60);
  if (hr < 24) return `~${hr}h`;
  const day = Math.ceil(hr / 24);
  return `~${day}d`;
}

function getETAColorClass(estimatedNext) {
  if (!estimatedNext) return "";
  const diff = estimatedNext - nowMs();
  if (diff <= 0) return "restock-eta-now";
  const hours = diff / (60 * 60 * 1000);
  if (hours < 1) return "restock-eta-imminent";
  if (hours < 6) return "restock-eta-soon";
  if (hours < 24) return "restock-eta-today";
  const days = diff / (24 * 60 * 60 * 1000);
  if (days < 7) return "restock-eta-week";
  if (days < 14) return "restock-eta-fortnight";
  return "restock-eta-far";
}

function ratePercent(rate) {
  if (rate === null) return "-";
  const pct = rate * 100;
  let maxDecimals;
  if (pct >= 80) maxDecimals = 0;
  else if (pct >= 40) maxDecimals = 1;
  else if (pct >= 10) maxDecimals = 2;
  else if (pct >= 1) maxDecimals = 3;
  else maxDecimals = 4;
  const formatted = pct.toFixed(maxDecimals);
  return `${parseFloat(formatted)}%`;
}

function getRateColorClass(rate) {
  if (rate === null) return "restock-rate-low";
  const pct = rate * 100;
  if (pct >= 80) return "restock-rate-high";
  if (pct >= 40) return "restock-rate-mid";
  return "restock-rate-low";
}

// === Prediction helpers ===
const SHOP_CYCLE_INTERVALS = {
  seed: 6 * 60 * 60 * 1000,
  egg: 6 * 60 * 60 * 1000,
  decor: 24 * 60 * 60 * 1000,
};

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function countDistinctCycles(timestamps, cycleMs) {
  const cycles = new Set();
  for (const ts of timestamps) {
    const n = typeof ts === "number" ? ts : Number(ts);
    if (!Number.isFinite(n)) continue;
    cycles.add(Math.floor(n / cycleMs));
  }
  return cycles.size;
}

function calculateAppearanceRate(item) {
  return item?.appearanceRate ?? null;
}

function predictItem(item) {
  if (!item.lastSeen || item.totalOccurrences < 2) {
    return {
      ...item,
      estimatedNextTimestamp: null,
      appearanceRate: null,
      averageQuantity: item.totalQuantity / Math.max(1, item.totalOccurrences),
      isEmpty: true,
    };
  }

  // Server-side Logic (Step Boost Model) via View
  // We trust the DB's values.

  return {
    ...item,
    estimatedNextTimestamp: item.estimatedNextTimestamp,
    appearanceRate: item.appearanceRate,
    averageQuantity: item.averageQuantity ?? 0,
    isEmpty: false,
  };
}

function formatFrequency(rate, shopType) {
  if (rate === null || rate <= 0) return "-";
  const interval = SHOP_CYCLE_INTERVALS[shopType];
  const expectedMs = interval / rate;
  if (rate >= 0.95) return "Every restock";
  const min = Math.round(expectedMs / 60000);
  if (min < 60) return `Every ~${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `Every ~${hr}h`;
  const day = Math.round(hr / 24);
  return `Every ~${day}d`;
}

function formatAvgQty(qty) {
  if (qty === null || qty <= 0) return "";
  if (qty >= 100) return `~${Math.round(qty)} avg`;
  if (qty >= 10) return `~${Math.round(qty)} avg`;
  if (Number.isInteger(qty)) return `~${qty} avg`;
  return `~${qty.toFixed(1)} avg`;
}

// === Render ===
function renderPredictions() {
  const container = document.getElementById("predictions-list");

  if (trackedItems.size === 0) {
    container.innerHTML = `
      <div class="empty-state">
        Click an item in the History to show next restock estimation
      </div>
    `;
    return;
  }

  const predictions = Array.from(trackedItems)
    .map((key) => {
      const [shopType, itemId] = key.split(":");
      const item = historyData.find((h) => h.itemId === itemId && h.shopType === shopType);
      if (!item) return null;
      return predictItem(item);
    })
    .filter((p) => p !== null)
    .sort((a, b) => {
      if (a.isEmpty && !b.isEmpty) return 1;
      if (!a.isEmpty && b.isEmpty) return -1;
      const rA = a.appearanceRate ?? -1;
      const rB = b.appearanceRate ?? -1;
      return rB - rA;
    });

  container.innerHTML =
    predictions
      .map((pred) => {
        const rarity = getRarity(pred.itemId, pred.shopType);
        const spriteUrl = getSpriteUrl(pred.itemId, pred.shopType);
        const tooltip = pred.isEmpty
          ? ""
          : `${formatAvgQty(pred.averageQuantity)}\n${formatFrequency(
            pred.appearanceRate,
            pred.shopType
          )}`;

        return `
          <div class="restock-pred-row" onclick="toggleTracking('${pred.shopType}', '${pred.itemId}')">
            <div class="restock-pred-left">
              <div class="restock-icon-wrap rarity-${rarity}">
                ${pred.shopType === "decor"
            ? `<img src="${getDecorSpriteUrl(
              pred.itemId
            )}" loading="lazy" decoding="async" class="restock-item-sprite restock-decor-icon" alt="${getItemName(
              pred.itemId,
              pred.shopType
            )}">`
            : spriteUrl
              ? `<img src="${spriteUrl}" data-fallback-src="${spriteUrl}?v=1" loading="lazy" decoding="async" class="restock-item-sprite" alt="${getItemName(
                pred.itemId,
                pred.shopType
              )}">`
              : ""}
              </div>
              <div class="restock-pred-text">
                <div class="restock-pred-line1">
                  <span class="restock-item-name restock-text-${rarity}">${getItemName(
                pred.itemId,
                pred.shopType
              )}</span>
                </div>
                <div class="restock-pred-line2">
                  ${pred.isEmpty ? "Not enough data" : `Seen ${formatRelative(pred.lastSeen)}`}
                </div>
              </div>
            </div>
            <div class="restock-pred-metrics">
              ${pred.isEmpty
            ? '<div class="restock-rate-low">--</div>'
            : `
                <div class="restock-pred-metric-wrap">
                  <div class="restock-pred-metric-value restock-eta-value ${getETAColorClass(
              pred.estimatedNextTimestamp
            )}">
                    ${formatETA(pred.estimatedNextTimestamp)}
                  </div>
                  <div class="restock-pred-metric-label">next</div>
                </div>
                <div class="restock-pred-metric-wrap" data-tooltip="${tooltip}">
                  <div class="restock-pred-metric-value ${getRateColorClass(
              pred.appearanceRate
            )}">
                    ${ratePercent(pred.appearanceRate)}
                  </div>
                  <div class="restock-pred-metric-label">rate</div>
                </div>
              `}
            </div>
          </div>
        `;
      })
      .join("") +
    `
      <div class="empty-state" style="padding: 8px 12px; font-size: 11px; opacity: 0.5;">
        Click to deselect the item in the Active Predictions
      </div>
    `;
}

function renderHistory() {
  const container = document.getElementById("history-table");

  let filtered = historyData.filter((item) => {
    if (currentFilter !== "all" && item.shopType !== currentFilter) return false;
    const expiryMs = getExpiryMs(item.itemId, item.shopType);
    if (expiryMs && expiryMs <= nowMs()) return false;
    if (currentSearch) {
      const search = currentSearch.toLowerCase();
      const name = getItemName(item.itemId, item.shopType).toLowerCase();
      if (!name.includes(search) && !item.itemId.toLowerCase().includes(search)) return false;
    }
    const key = `${item.shopType}:${item.itemId}`;
    return !trackedItems.has(key);
  });

  if (sortColumn) {
    filtered.sort((a, b) => {
      let aVal;
      let bVal;

      if (sortColumn === "item") {
        aVal = getItemName(a.itemId, a.shopType).toLowerCase();
        bVal = getItemName(b.itemId, b.shopType).toLowerCase();
      } else if (sortColumn === "shop") {
        const shopOrder = { seed: 0, egg: 1, decor: 2 };
        aVal = shopOrder[a.shopType];
        bVal = shopOrder[b.shopType];
      } else if (sortColumn === "rarity") {
        const rarityWeights = {
          common: 0,
          uncommon: 1,
          rare: 2,
          legendary: 3,
          mythic: 4,
          mythical: 4,
          divine: 5,
          celestial: 6,
        };
        aVal = rarityWeights[getRarity(a.itemId, a.shopType)];
        bVal = rarityWeights[getRarity(b.itemId, b.shopType)];
      } else if (sortColumn === "price") {
        aVal = getCoinPrice(a.itemId, a.shopType);
        bVal = getCoinPrice(b.itemId, b.shopType);
      } else if (sortColumn === "qty") {
        aVal = a.totalQuantity || 0;
        bVal = b.totalQuantity || 0;
      } else if (sortColumn === "last") {
        aVal = a.lastSeen || 0;
        bVal = b.lastSeen || 0;
      }

      if (aVal === bVal) return 0;
      if (sortDirection === "asc") {
        return aVal > bVal ? 1 : -1;
      }
      return aVal < bVal ? 1 : -1;
    });
  } else {
    const rarityWeights = {
      common: 0,
      uncommon: 1,
      rare: 2,
      legendary: 3,
      mythic: 4,
      mythical: 4,
      divine: 5,
      celestial: 6,
    };
    const shopOrder = { seed: 0, egg: 1, decor: 2 };

    filtered.sort((a, b) => {
      const shopA = shopOrder[a.shopType] ?? 99;
      const shopB = shopOrder[b.shopType] ?? 99;
      if (shopA !== shopB) return shopA - shopB;

      const rarityA = rarityWeights[getRarity(a.itemId, a.shopType)] ?? 99;
      const rarityB = rarityWeights[getRarity(b.itemId, b.shopType)] ?? 99;
      if (rarityA !== rarityB) return rarityA - rarityB;

      const priceA = getCoinPrice(a.itemId, a.shopType);
      const priceB = getCoinPrice(b.itemId, b.shopType);
      if (priceA !== priceB) return priceA - priceB;

      const nameA = getItemName(a.itemId, a.shopType);
      const nameB = getItemName(b.itemId, b.shopType);
      return nameA.localeCompare(nameB, undefined, { sensitivity: "base" });
    });
  }

  if (!sortColumn) {
    sortDirection = "asc";
  }

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th onclick="sortTable('item')" style="width: 60%;">
            Item
            <span class="sort-indicator ${sortColumn === "item" ? "active" : ""}">
              ${sortColumn === "item" ? (sortDirection === "asc" ? "▲" : "▼") : ""}
            </span>
          </th>
          <th onclick="sortTable('qty')" style="width: 15%; text-align: center;">
            Quantity
            <span class="sort-indicator ${sortColumn === "qty" ? "active" : ""}">
              ${sortColumn === "qty" ? (sortDirection === "asc" ? "▲" : "▼") : ""}
            </span>
          </th>
          <th onclick="sortTable('last')" style="width: 15%; text-align: right;">
            Seen
            <span class="sort-indicator ${sortColumn === "last" ? "active" : ""}">
              ${sortColumn === "last" ? (sortDirection === "asc" ? "▲" : "▼") : ""}
            </span>
          </th>
        </tr>
      </thead>
      <tbody>
        ${filtered
      .map((item) => {
        const rarity = getRarity(item.itemId, item.shopType);
        const spriteUrl = getSpriteUrl(item.itemId, item.shopType);
        const exact = {
          primary: formatClock(item.lastSeen),
          secondary: formatRelativeDay(item.lastSeen),
          title: item.lastSeen ? new Date(item.lastSeen).toLocaleString() : "-",
        };

        return `
              <tr onclick="toggleTracking('${item.shopType}', '${item.itemId}')">
                <td>
                  <div class="restock-item-cell">
                    <div class="restock-icon-wrap rarity-${rarity}">
                      ${item.shopType === "decor"
            ? `<img src="${getDecorSpriteUrl(
              item.itemId
            )}" loading="lazy" decoding="async" class="restock-item-sprite restock-decor-icon" alt="${getItemName(
              item.itemId,
              item.shopType
            )}">`
            : spriteUrl
              ? `<img src="${spriteUrl}" data-fallback-src="${spriteUrl}?v=1" loading="lazy" decoding="async" class="restock-item-sprite" alt="${getItemName(
                item.itemId,
                item.shopType
              )}">`
              : ""}
                    </div>
                    <div class="restock-item-info">
                      <div class="restock-item-name restock-text-${rarity}">${getItemName(
                item.itemId,
                item.shopType
              )}</div>
                      <div class="restock-item-sub">
                        <span class="restock-price-wrap">
                          <img src="./coin.png" class="restock-coin-icon" alt="Coins">
                          <span>${formatPrice(getCoinPrice(item.itemId, item.shopType))}</span>
                        </span>
                      </div>
                    </div>
                  </div>
                </td>
                <td style="text-align: center; font-variant-numeric: tabular-nums; font-weight: 600; opacity: 0.9;">
                  ${formatPrice(item.totalQuantity || 0)}
                </td>
                <td>
                  <div class="restock-time-cell" title="${exact.title}">
                    <div style="font-weight: 600;">${exact.primary}</div>
                    ${exact.secondary
            ? `<div style="opacity: 0.7; font-size: 11px;">${exact.secondary}</div>`
            : ""}
                  </div>
                </td>
              </tr>
            `;
      })
      .join("")}
      </tbody>
    </table>
  `;

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state">No items found</div>';
  }

  prefetchVisibleSprites();
  const spriteImages = container.querySelectorAll("img.restock-item-sprite");
  spriteImages.forEach((img) => applySpriteFallback(img));
  bindPrefetchScroll();
}

// === Interaction ===
function toggleTracking(shopType, itemId) {
  const key = `${shopType}:${itemId}`;
  if (trackedItems.has(key)) {
    trackedItems.delete(key);
  } else {
    trackedItems.add(key);
  }
  saveTrackedItems();
  renderPredictions();
  renderHistory();
}

function setFilter(filter) {
  currentFilter = filter;
  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.filter === filter);
  });
  renderHistory();
}

function handleSearch(value) {
  currentSearch = value.trim().toLowerCase();
  renderHistory();
}

function sortTable(column) {
  if (sortColumn === column) {
    sortDirection = sortDirection === "asc" ? "desc" : "asc";
  } else {
    sortColumn = column;
    sortDirection = "asc";
  }
  renderHistory();
}

window.toggleTracking = toggleTracking;
window.setFilter = setFilter;
window.handleSearch = handleSearch;
window.sortTable = sortTable;

// === Persistence ===
function saveTrackedItems() {
  localStorage.setItem("trackedItems", JSON.stringify(Array.from(trackedItems)));
}

function loadTrackedItems() {
  try {
    const saved = localStorage.getItem("trackedItems");
    if (saved) {
      trackedItems = new Set(JSON.parse(saved));
    }
  } catch (e) {
    console.error("Failed to load tracked items:", e);
  }
}

// === Init ===
export async function initApp() {
  loadTrackedItems();
  await loadHistoryData();
  renderPredictions();
  renderHistory();
}


