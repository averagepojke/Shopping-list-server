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
// ---------------------------------------------------------------------------
async function searchTrolley(query) {
  const url = `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}&filter_menus=1`;
  console.log(`  [trolley] fetching: ${url}`);

  const res = await safeFetch(url, { headers: HEADERS }, 12000);
  console.log(`  [trolley] status: ${res.status}, content-type: ${res.headers.get("content-type")}`);

  const html = await res.text();

  // Log first 1000 chars so we can see what's actually returned
  console.log(`  [trolley] response preview:\n${html.slice(0, 1000)}\n---`);

  // Try multiple ID patterns found on trolley.co.uk
  // Pattern 1: 3 uppercase letters + 3 digits e.g. MOZ184
  const pattern1 = /\b([A-Z]{3}[0-9]{3})\b/g;
  // Pattern 2: data-product_id or data-id attributes
  const pattern2 = /data-product[_-]?id="([^"]+)"/gi;
  const pattern3 = /data-id="([^"]+)"/gi;
  // Pattern 4: product_id in JS variables
  const pattern4 = /product_id['":\s]+['"]([^'"]+)['"]/gi;
  // Pattern 5: href containing /product/ path
  const pattern5 = /\/product\/([a-z0-9-]+)\//gi;

  const seen = new Set();
  const productIds = [];

  const addIds = (pattern) => {
    for (const m of html.matchAll(pattern)) {
      const id = m[1];
      if (!seen.has(id)) {
        seen.add(id);
        productIds.push(id);
      }
    }
  };

  addIds(pattern1);
  addIds(pattern2);
  addIds(pattern3);
  addIds(pattern4);
  addIds(pattern5);

  console.log(`  [trolley] found ${productIds.length} product IDs: ${productIds.slice(0, 10).join(", ")}`);
  return productIds.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Step 2: Get prices via trueview.php
// ---------------------------------------------------------------------------
async function getTrueviewPrices(productIds) {
  if (productIds.length === 0) return [];

  const idParam = productIds.join("|");
  const posParam = productIds.map((_, i) => i + 1).join("|");
  const url = `https://www.trolley.co.uk/_library/ajax/trueview.php?product_id=${encodeURIComponent(idParam)}&p=${encodeURIComponent(posParam)}&sid=`;

  console.log(`  [trueview] fetching prices for: ${productIds.slice(0, 5).join(", ")}...`);

  const res = await safeFetch(url, {
    headers: {
      ...HEADERS,
      Accept: "application/json, text/javascript, */*",
      "X-Requested-With": "XMLHttpRequest",
    },
  }, 12000);

  console.log(`  [trueview] status: ${res.status}`);
  const text = await res.text();
  console.log(`  [trueview] response preview:\n${text.slice(0, 1000)}\n---`);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.warn("  [trueview] not JSON, trying HTML parser");
    return parseTrueviewHtml(text);
  }

  return parseTrueviewJson(data);
}

// ---------------------------------------------------------------------------
// Parse JSON response — log the raw structure so we can see what keys exist
// ---------------------------------------------------------------------------
function parseTrueviewJson(data) {
  console.log(`  [trueview] JSON keys: ${JSON.stringify(Object.keys(data ?? {}))}`);
  const results = [];

  const items = Array.isArray(data) ? data : (data.products ?? data.results ?? data.items ?? Object.values(data));

  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    const productName = item.name ?? item.title ?? item.product_name ?? "";
    const stores = item.stores ?? item.prices ?? item.retailers ?? [];

    if (Array.isArray(stores)) {
      for (const store of stores) {
        const price = store.price ?? store.current_price ?? store.value;
        const storeName = store.store ?? store.retailer ?? store.name ?? store.source ?? "";
        if (price != null && storeName) {
          results.push({
            name: productName,
            price: formatPrice(price),
            unit: store.unit_price ?? store.per_unit ?? "",
            store: storeName,
          });
        }
      }
    } else {
      // Flat structure: tesco_price, asda_price etc.
      const storeKeys = ["tesco", "sainsburys", "asda", "morrisons", "ocado", "aldi", "lidl", "waitrose", "iceland", "coop"];
      for (const key of storeKeys) {
        const price = item[`${key}_price`] ?? item[key];
        if (price != null && price !== "" && price !== "N/A") {
          results.push({
            name: productName,
            price: formatPrice(price),
            unit: item[`${key}_unit`] ?? "",
            store: key.charAt(0).toUpperCase() + key.slice(1),
          });
        }
      }
    }
  }

  return results;
}

function parseTrueviewHtml(html) {
  const results = [];
  const storePatterns = [
    { name: "Tesco",        pattern: /tesco[^£\n]{0,60}£([\d.]+)/gi },
    { name: "Sainsbury's",  pattern: /sainsbury[^£\n]{0,60}£([\d.]+)/gi },
    { name: "ASDA",         pattern: /asda[^£\n]{0,60}£([\d.]+)/gi },
    { name: "Morrisons",    pattern: /morrison[^£\n]{0,60}£([\d.]+)/gi },
    { name: "Ocado",        pattern: /ocado[^£\n]{0,60}£([\d.]+)/gi },
    { name: "Waitrose",     pattern: /waitrose[^£\n]{0,60}£([\d.]+)/gi },
    { name: "Iceland",      pattern: /iceland[^£\n]{0,60}£([\d.]+)/gi },
    { name: "Aldi",         pattern: /aldi[^£\n]{0,60}£([\d.]+)/gi },
  ];
  for (const { name, pattern } of storePatterns) {
    const match = pattern.exec(html);
    if (match) results.push({ name: "", price: `£${parseFloat(match[1]).toFixed(2)}`, unit: "", store: name });
  }
  return results;
}

function formatPrice(price) {
  const num = parseFloat(String(price).replace(/[^0-9.]/g, ""));
  if (isNaN(num)) return String(price);
  if (num > 20 && !String(price).includes(".") && num === Math.floor(num)) return `£${(num / 100).toFixed(2)}`;
  return `£${num.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing ?q= parameter" });
  console.log(`\nSearching: "${query}"`);
  try {
    const productIds = await searchTrolley(query);
    if (productIds.length === 0) return res.json({ query, results: [] });
    const results = await getTrueviewPrices(productIds);
    console.log(`  → ${results.length} store prices returned`);
    res.json({ query, results });
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(3000, () => console.log("Running on port 3000"));