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
// Try to find the right search endpoint by probing candidates
// ---------------------------------------------------------------------------
async function searchTrolley(query) {
  const q = encodeURIComponent(query);

  // Candidate endpoints — we try each and log the response
  const candidates = [
    // Plain search page (no filter_menus)
    `https://www.trolley.co.uk/search/?q=${q}`,
    // AJAX product results endpoint
    `https://www.trolley.co.uk/_library/ajax/search.php?q=${q}`,
    `https://www.trolley.co.uk/_library/ajax/products.php?q=${q}`,
    `https://www.trolley.co.uk/search/?q=${q}&ajax=1`,
    `https://www.trolley.co.uk/search/?q=${q}&format=json`,
    `https://www.trolley.co.uk/api/search?q=${q}`,
    `https://www.trolley.co.uk/api/products?q=${q}`,
  ];

  for (const url of candidates) {
    try {
      console.log(`  [probe] trying: ${url}`);
      const res = await safeFetch(url, { headers: AJAX_HEADERS }, 8000);
      const ct = res.headers.get("content-type") ?? "";
      const text = await res.text();
      console.log(`  [probe] ${res.status} ${ct} — preview: ${text.slice(0, 300).replace(/\n/g, " ")}`);
      console.log("  ---");

      // Check for product IDs pattern [A-Z]{3}[0-9]{3}
      const ids = extractProductIds(text);
      if (ids.length > 0) {
        console.log(`  [probe] ✓ found ${ids.length} product IDs at ${url}`);
        return ids.slice(0, 10);
      }

      // Check if it looks like JSON with products
      if (ct.includes("json")) {
        try {
          const json = JSON.parse(text);
          console.log(`  [probe] JSON keys: ${JSON.stringify(Object.keys(json)).slice(0, 200)}`);
          // If it has products/results array, try to extract
          const items = json.products ?? json.results ?? json.items ?? json.data ?? [];
          if (Array.isArray(items) && items.length > 0) {
            console.log(`  [probe] ✓ found ${items.length} items in JSON at ${url}`);
            return items; // Return raw items for JSON path
          }
        } catch { /* not valid JSON */ }
      }
    } catch (err) {
      console.log(`  [probe] error: ${err.message}`);
    }
  }

  console.log("  [probe] no product endpoint found — check logs above");
  return [];
}

function extractProductIds(text) {
  const pattern = /\b([A-Z]{3}[0-9]{3})\b/g;
  const seen = new Set();
  const ids = [];
  for (const m of text.matchAll(pattern)) {
    if (!seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Get prices via trueview.php
// ---------------------------------------------------------------------------
async function getTrueviewPrices(productIds) {
  if (productIds.length === 0) return [];

  const idParam = productIds.join("|");
  const posParam = productIds.map((_, i) => i + 1).join("|");
  const url = `https://www.trolley.co.uk/_library/ajax/trueview.php?product_id=${encodeURIComponent(idParam)}&p=${encodeURIComponent(posParam)}&sid=`;

  console.log(`  [trueview] fetching: ${url.slice(0, 120)}`);
  const res = await safeFetch(url, { headers: AJAX_HEADERS }, 12000);
  console.log(`  [trueview] status: ${res.status}`);

  const text = await res.text();
  console.log(`  [trueview] preview: ${text.slice(0, 500).replace(/\n/g, " ")}`);

  let data;
  try { data = JSON.parse(text); }
  catch { return parseTrueviewHtml(text); }

  console.log(`  [trueview] JSON structure: ${JSON.stringify(data).slice(0, 300)}`);
  return parseTrueviewJson(data);
}

function parseTrueviewJson(data) {
  const results = [];
  const items = Array.isArray(data) ? data : Object.values(data);

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const productName = item.name ?? item.title ?? item.product_name ?? "";
    const stores = item.stores ?? item.prices ?? item.retailers ?? [];

    if (Array.isArray(stores) && stores.length > 0) {
      for (const store of stores) {
        const price = store.price ?? store.current_price ?? store.value;
        const storeName = store.store ?? store.retailer ?? store.name ?? "";
        if (price != null && storeName) {
          results.push({ name: productName, price: formatPrice(price), unit: store.unit_price ?? "", store: storeName });
        }
      }
    } else {
      // Flat key structure
      for (const [k, v] of Object.entries(item)) {
        if (k.includes("price") && v && v !== "N/A") {
          const storeName = k.replace(/_?price/i, "").replace(/_/g, " ").trim();
          if (storeName) results.push({ name: productName, price: formatPrice(v), unit: "", store: storeName });
        }
      }
    }
  }
  return results;
}

function parseTrueviewHtml(html) {
  const results = [];
  const stores = [
    ["Tesco", /tesco/i], ["Sainsbury's", /sainsbury/i], ["ASDA", /asda/i],
    ["Morrisons", /morrison/i], ["Ocado", /ocado/i], ["Waitrose", /waitrose/i],
    ["Iceland", /iceland/i], ["Aldi", /aldi/i],
  ];
  for (const [name, rx] of stores) {
    const idx = html.search(rx);
    if (idx === -1) continue;
    const nearby = html.slice(idx, idx + 100);
    const m = nearby.match(/£([\d.]+)/);
    if (m) results.push({ name: "", price: `£${parseFloat(m[1]).toFixed(2)}`, unit: "", store: name });
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