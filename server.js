const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-GB,en;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Referer": "https://www.trolley.co.uk/",
};

// ---------------------------------------------------------------------------
// Helper: fetch with timeout
// ---------------------------------------------------------------------------
async function safeFetch(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Step 1: Search trolley.co.uk and extract product IDs from the HTML
// Product IDs are 3 uppercase letters + 3 digits e.g. MOZ184, SOY634
// ---------------------------------------------------------------------------
async function searchTrolley(query) {
  const url = `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}&filter_menus=1`;

  const res = await safeFetch(url, { headers: HEADERS }, 12000);
  if (!res.ok) throw new Error(`Trolley search HTTP ${res.status}`);
  const html = await res.text();

  // Extract product IDs — they appear in data attributes and JS arrays in the page
  // Pattern: 3 uppercase letters followed by 3 digits
  const idPattern = /\b([A-Z]{3}[0-9]{3})\b/g;
  const allMatches = [...html.matchAll(idPattern)].map(m => m[1]);

  // Deduplicate while preserving order
  const seen = new Set();
  const productIds = [];
  for (const id of allMatches) {
    if (!seen.has(id)) {
      seen.add(id);
      productIds.push(id);
    }
  }

  console.log(`  [trolley search] found ${productIds.length} product IDs for "${query}"`);
  return productIds.slice(0, 10); // take top 10 results
}

// ---------------------------------------------------------------------------
// Step 2: Get prices for a list of product IDs via trueview.php
// Returns store prices for each product
// ---------------------------------------------------------------------------
async function getTrueviewPrices(productIds) {
  if (productIds.length === 0) return [];

  // Build pipe-separated lists
  const idParam = productIds.join("|");
  const posParam = productIds.map((_, i) => i + 1).join("|");

  const url =
    `https://www.trolley.co.uk/_library/ajax/trueview.php` +
    `?product_id=${encodeURIComponent(idParam)}&p=${encodeURIComponent(posParam)}&sid=`;

  const res = await safeFetch(url, {
    headers: {
      ...HEADERS,
      Accept: "application/json, text/javascript, */*",
      "X-Requested-With": "XMLHttpRequest",
    },
  }, 12000);

  if (!res.ok) throw new Error(`Trueview HTTP ${res.status}`);

  const text = await res.text();

  // Try to parse as JSON
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.warn("  [trueview] non-JSON response, trying to extract prices from HTML");
    return parseTrueviewHtml(text, productIds);
  }

  return parseTrueviewJson(data, productIds);
}

// ---------------------------------------------------------------------------
// Parse trueview JSON response
// Structure may vary — we look for price, store name, product name
// ---------------------------------------------------------------------------
function parseTrueviewJson(data, productIds) {
  const results = [];

  // Handle array of products
  const items = Array.isArray(data) ? data : (data.products ?? data.results ?? data.items ?? Object.values(data));

  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    // Each item may contain multiple store prices
    const stores = item.stores ?? item.prices ?? item.retailers ?? (Array.isArray(item) ? item : null);

    const productName = item.name ?? item.title ?? item.product_name ?? "";

    if (Array.isArray(stores)) {
      for (const store of stores) {
        const price = store.price ?? store.current_price ?? store.value;
        const storeName = store.store ?? store.retailer ?? store.name ?? store.source ?? "";
        if (price != null && storeName) {
          results.push({
            name: productName || storeName,
            price: formatPrice(price),
            unit: store.unit_price ?? store.per_unit ?? "",
            store: storeName,
          });
        }
      }
    } else {
      // Maybe flat structure: { name, tesco_price, asda_price, ... }
      const storeKeys = ["tesco", "sainsburys", "asda", "morrisons", "ocado", "aldi", "lidl", "waitrose", "iceland", "coop"];
      for (const key of storeKeys) {
        const price = item[`${key}_price`] ?? item[key];
        if (price != null && price !== "" && price !== "N/A") {
          results.push({
            name: productName,
            price: formatPrice(price),
            unit: item[`${key}_unit`] ?? "",
            store: capitalise(key),
          });
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Fallback: parse trueview HTML response for price data
// Trolley sometimes returns an HTML snippet rather than JSON
// ---------------------------------------------------------------------------
function parseTrueviewHtml(html, productIds) {
  const results = [];

  // Look for price patterns like £1.50, 1.50, etc near store names
  const storePatterns = [
    { name: "Tesco", pattern: /tesco[^£]*£([\d.]+)/gi },
    { name: "Sainsbury's", pattern: /sainsbury[^£]*£([\d.]+)/gi },
    { name: "ASDA", pattern: /asda[^£]*£([\d.]+)/gi },
    { name: "Morrisons", pattern: /morrison[^£]*£([\d.]+)/gi },
    { name: "Ocado", pattern: /ocado[^£]*£([\d.]+)/gi },
    { name: "Waitrose", pattern: /waitrose[^£]*£([\d.]+)/gi },
    { name: "Iceland", pattern: /iceland[^£]*£([\d.]+)/gi },
    { name: "Aldi", pattern: /aldi[^£]*£([\d.]+)/gi },
  ];

  // Also try to get product name from HTML title tags
  const nameMatch = html.match(/<(?:h[1-3]|strong|b)[^>]*>([^<]{3,80})<\/(?:h[1-3]|strong|b)>/i);
  const productName = nameMatch ? nameMatch[1].trim() : "";

  for (const { name, pattern } of storePatterns) {
    const match = pattern.exec(html);
    if (match) {
      results.push({
        name: productName,
        price: `£${parseFloat(match[1]).toFixed(2)}`,
        unit: "",
        store: name,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatPrice(price) {
  const num = parseFloat(String(price).replace(/[^0-9.]/g, ""));
  if (isNaN(num)) return String(price);
  // Trolley sometimes stores prices in pence (integers > 20 without decimal)
  // Heuristic: if value > 20 and no decimal point in original, treat as pence
  if (num > 20 && !String(price).includes(".") && num === Math.floor(num)) {
    return `£${(num / 100).toFixed(2)}`;
  }
  return `£${num.toFixed(2)}`;
}

function capitalise(str) {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// ---------------------------------------------------------------------------
// GET /search?q=milk
// ---------------------------------------------------------------------------
app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing ?q= parameter" });

  console.log(`\nSearching: "${query}"`);

  try {
    // Step 1: get product IDs from search page
    const productIds = await searchTrolley(query);
    if (productIds.length === 0) {
      return res.json({ query, results: [] });
    }

    // Step 2: get prices for those products
    const results = await getTrueviewPrices(productIds);
    console.log(`  → ${results.length} store prices returned`);

    res.json({ query, results });
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
app.get("/health", (_, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(3000, () => console.log("Running on port 3000"));