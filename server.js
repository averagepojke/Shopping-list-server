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

const AJAX_HEADERS = {
  ...HEADERS,
  "Accept": "application/json, text/javascript, */*; q=0.01",
  "X-Requested-With": "XMLHttpRequest",
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
// Step 1: Search trolley.co.uk — plain URL works, no filter_menus param
// ---------------------------------------------------------------------------
async function searchTrolley(query) {
  const url = `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`;
  console.log(`  [search] GET ${url}`);

  const res = await safeFetch(url, { headers: HEADERS }, 12000);
  console.log(`  [search] status: ${res.status}`);

  const html = await res.text();

  // Extract [A-Z]{3}[0-9]{3} product IDs
  const seen = new Set();
  const ids = [];
  for (const m of html.matchAll(/\b([A-Z]{3}[0-9]{3})\b/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
  }

  // Also try to grab product names from the HTML for better labelling
  const nameMap = {};
  // Pattern: product ID appears near a product name in the HTML
  const namePattern = /([A-Z]{3}[0-9]{3})[^]*?(?:data-name|alt|title)="([^"]{3,80})"/g;
  for (const m of html.matchAll(namePattern)) {
    if (!nameMap[m[1]]) nameMap[m[1]] = m[2];
  }

  console.log(`  [search] found ${ids.length} product IDs`);
  if (ids.length > 0) console.log(`  [search] first 5: ${ids.slice(0, 5).join(", ")}`);

  return { ids: ids.slice(0, 10), nameMap };
}

// ---------------------------------------------------------------------------
// Step 2: Get prices via trueview.php
// ---------------------------------------------------------------------------
async function getTrueviewPrices(ids, nameMap = {}) {
  if (ids.length === 0) return [];

  const idParam = ids.join("|");
  const posParam = ids.map((_, i) => i + 1).join("|");
  const url = `https://www.trolley.co.uk/_library/ajax/trueview.php?product_id=${encodeURIComponent(idParam)}&p=${encodeURIComponent(posParam)}&sid=`;

  console.log(`  [trueview] fetching ${ids.length} products`);
  const res = await safeFetch(url, { headers: AJAX_HEADERS }, 15000);
  console.log(`  [trueview] status: ${res.status}, content-type: ${res.headers.get("content-type")}`);

  const text = await res.text();
  console.log(`  [trueview] response (first 800 chars):\n${text.slice(0, 800)}\n---`);

  if (!text || text.trim() === "") {
    console.warn("  [trueview] empty response");
    return [];
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.warn("  [trueview] not valid JSON, trying HTML parser");
    return parseTrueviewHtml(text);
  }

  return parseTrueviewJson(data, nameMap);
}

// ---------------------------------------------------------------------------
// Parse trueview JSON — handles multiple possible structures
// ---------------------------------------------------------------------------
function parseTrueviewJson(data, nameMap = {}) {
  const results = [];

  // Log full structure to understand shape
  const sample = JSON.stringify(data).slice(0, 600);
  console.log(`  [trueview] JSON sample: ${sample}`);

  // Could be: object keyed by product_id, array of products, or nested
  const items = Array.isArray(data) ? data : Object.entries(data);

  for (const entry of items) {
    // Handle object entries [key, value] or plain array items
    const [productId, item] = Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string"
      ? entry
      : [null, entry];

    if (!item || typeof item !== "object") continue;

    const productName = item.name ?? item.title ?? item.product_name ?? nameMap[productId] ?? productId ?? "";

    // Structure A: item.stores is an array
    if (Array.isArray(item.stores)) {
      for (const store of item.stores) {
        const price = store.price ?? store.current_price ?? store.value ?? store.p;
        const storeName = store.store ?? store.retailer ?? store.name ?? store.r ?? "";
        if (price != null && price !== "" && storeName) {
          results.push({ name: productName, price: formatPrice(price), unit: store.unit_price ?? store.u ?? "", store: storeName });
        }
      }
      continue;
    }

    // Structure B: item.prices is an array
    if (Array.isArray(item.prices)) {
      for (const p of item.prices) {
        const price = p.price ?? p.p ?? p.value;
        const storeName = p.store ?? p.retailer ?? p.name ?? p.r ?? "";
        if (price != null && storeName) {
          results.push({ name: productName, price: formatPrice(price), unit: p.unit ?? "", store: storeName });
        }
      }
      continue;
    }

    // Structure C: flat keys like tesco_price, asda_price
    const storeKeys = [
      ["tesco", "Tesco"], ["sainsburys", "Sainsbury's"], ["sainsbury", "Sainsbury's"],
      ["asda", "ASDA"], ["morrisons", "Morrisons"], ["morrison", "Morrisons"],
      ["ocado", "Ocado"], ["waitrose", "Waitrose"], ["iceland", "Iceland"],
      ["aldi", "Aldi"], ["lidl", "Lidl"], ["coop", "Co-op"], ["boots", "Boots"],
    ];
    for (const [key, displayName] of storeKeys) {
      const price = item[`${key}_price`] ?? item[`${key}Price`] ?? item[key];
      if (price != null && price !== "" && price !== "N/A" && price !== false) {
        const unit = item[`${key}_unit`] ?? item[`${key}Unit`] ?? "";
        results.push({ name: productName, price: formatPrice(price), unit, store: displayName });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Fallback HTML parser
// ---------------------------------------------------------------------------
function parseTrueviewHtml(html) {
  const results = [];
  const stores = [
    ["Tesco", /tesco/i], ["Sainsbury's", /sainsbury/i], ["ASDA", /asda/i],
    ["Morrisons", /morrison/i], ["Ocado", /ocado/i], ["Waitrose", /waitrose/i],
    ["Iceland", /iceland/i], ["Aldi", /aldi/i], ["Lidl", /lidl/i],
  ];
  for (const [name, rx] of stores) {
    const idx = html.search(rx);
    if (idx === -1) continue;
    const nearby = html.slice(Math.max(0, idx - 50), idx + 150);
    const m = nearby.match(/£([\d.]+)/);
    if (m) results.push({ name: "", price: `£${parseFloat(m[1]).toFixed(2)}`, unit: "", store: name });
  }
  return results;
}

function formatPrice(price) {
  const num = parseFloat(String(price).replace(/[^0-9.]/g, ""));
  if (isNaN(num)) return String(price);
  // If value looks like pence (integer > 20 with no decimal), convert
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
    const { ids, nameMap } = await searchTrolley(query);
    if (ids.length === 0) return res.json({ query, results: [] });

    const results = await getTrueviewPrices(ids, nameMap);
    console.log(`  → ${results.length} store prices returned`);
    res.json({ query, results });
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(3000, () => console.log("Running on port 3000"));