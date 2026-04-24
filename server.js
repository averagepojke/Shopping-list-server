const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());

const BASE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-GB,en;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

async function safeFetch(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Step 1: Search — capture cookies from the response for use in trueview
// ---------------------------------------------------------------------------
async function searchTrolley(query) {
  const url = `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`;
  console.log(`  [search] GET ${url}`);

  const res = await safeFetch(url, {
    headers: { ...BASE_HEADERS, "Referer": "https://www.trolley.co.uk/" },
  });
  console.log(`  [search] status: ${res.status}`);

  // ── Capture cookies for the trueview call ──────────────────────────────
  // trueview.php almost certainly checks for a valid session cookie set by
  // the search page (or the homepage). Forward every Set-Cookie value.
  const rawCookies = res.headers.raw()["set-cookie"] ?? [];
  const cookieStr = rawCookies
    .map(c => c.split(";")[0])   // keep only name=value, strip flags
    .join("; ");
  console.log(`  [search] captured ${rawCookies.length} cookie(s): ${cookieStr.slice(0, 120)}`);

  const html = await res.text();

  // ── Extract product IDs ────────────────────────────────────────────────
  // Strategy 1: data-product-id or data-id attributes (most reliable)
  const seen = new Set();
  const ids = [];
  const nameMap = {};

  // data-product-id="MIL001" or data-id="MIL001"
  for (const m of html.matchAll(/data-(?:product-)?id="([A-Z]{2,4}[0-9]{2,4})"/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
  }

  // Strategy 2: /product/MIL001-some-name/ URL paths
  for (const m of html.matchAll(/\/product\/([A-Z]{2,4}[0-9]{2,4})-/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
  }

  // Strategy 3: Fallback — bare word boundary match (original approach)
  // Only use if the above found nothing
  if (ids.length === 0) {
    for (const m of html.matchAll(/\b([A-Z]{3}[0-9]{3})\b/g)) {
      if (!seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
    }
    console.log(`  [search] fell back to bare-word regex, found ${ids.length}`);
  }

  // ── Extract product names ──────────────────────────────────────────────
  // Try several patterns — whichever fires first for each ID wins
  const namePatterns = [
    /data-(?:product-)?id="([A-Z]{2,4}[0-9]{2,4})"[^>]*data-name="([^"]{3,100})"/g,
    /([A-Z]{2,4}[0-9]{2,4})[^"]*"[^>]*(?:alt|title)="([^"]{3,100})"/g,
  ];
  for (const pat of namePatterns) {
    for (const m of html.matchAll(pat)) {
      if (!nameMap[m[1]]) nameMap[m[1]] = m[2];
    }
  }

  console.log(`  [search] found ${ids.length} product IDs (first 5: ${ids.slice(0, 5).join(", ")})`);
  return { ids: ids.slice(0, 10), nameMap, cookieStr };
}

// ---------------------------------------------------------------------------
// Step 2: Get prices via trueview.php — now includes the session cookie
// ---------------------------------------------------------------------------
async function getTrueviewPrices(ids, nameMap = {}, cookieStr = "") {
  if (ids.length === 0) return [];

  const idParam = ids.join("|");
  const posParam = ids.map((_, i) => i + 1).join("|");
  const url = `https://www.trolley.co.uk/_library/ajax/trueview.php` +
    `?product_id=${encodeURIComponent(idParam)}&p=${encodeURIComponent(posParam)}&sid=`;

  const headers = {
    ...BASE_HEADERS,
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://www.trolley.co.uk/search/",
    // ← THE KEY FIX: pass back the cookies from the search response
    ...(cookieStr ? { "Cookie": cookieStr } : {}),
  };

  console.log(`  [trueview] fetching ${ids.length} products`);
  console.log(`  [trueview] Cookie header: ${cookieStr.slice(0, 120)}`);

  const res = await safeFetch(url, { headers });
  const contentType = res.headers.get("content-type") ?? "";
  console.log(`  [trueview] status: ${res.status} | content-type: ${contentType}`);

  const text = await res.text();
  console.log(`  [trueview] body length: ${text.length}`);
  console.log(`  [trueview] body (first 1000 chars):\n${text.slice(0, 1000)}\n---`);

  if (!text || text.trim() === "") {
    console.warn("  [trueview] ⚠ empty response — cookie may still be wrong or endpoint moved");
    return [];
  }

  // ── Parse response ────────────────────────────────────────────────────
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.warn("  [trueview] not JSON, trying HTML fallback parser");
    return parseTrueviewHtml(text);
  }

  return parseTrueviewJson(data, nameMap);
}

// ---------------------------------------------------------------------------
// Parse trueview JSON — handles multiple possible structures
// ---------------------------------------------------------------------------
function parseTrueviewJson(data, nameMap = {}) {
  const results = [];
  console.log(`  [trueview] JSON sample: ${JSON.stringify(data).slice(0, 600)}`);

  const items = Array.isArray(data) ? data.map((v, i) => [String(i), v])
    : Object.entries(data);

  for (const [productId, item] of items) {
    if (!item || typeof item !== "object") continue;

    const productName =
      item.name ?? item.title ?? item.product_name ?? nameMap[productId] ?? productId ?? "";

    // Structure A: item.stores = [{store, price, unit_price}, ...]
    if (Array.isArray(item.stores)) {
      for (const store of item.stores) {
        const price = store.price ?? store.current_price ?? store.value ?? store.p;
        const storeName = store.store ?? store.retailer ?? store.name ?? store.r ?? "";
        if (price != null && price !== "" && storeName) {
          results.push({
            name: productName,
            price: formatPrice(price),
            unit: store.unit_price ?? store.u ?? "",
            store: storeName,
          });
        }
      }
      continue;
    }

    // Structure B: item.prices = [{store, price}, ...]
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

    // Structure C: flat keys — tesco_price, asda_price, etc.
    const storeKeys = [
      ["tesco", "Tesco"], ["sainsburys", "Sainsbury's"], ["sainsbury", "Sainsbury's"],
      ["asda", "ASDA"], ["morrisons", "Morrisons"], ["morrison", "Morrisons"],
      ["ocado", "Ocado"], ["waitrose", "Waitrose"], ["iceland", "Iceland"],
      ["aldi", "Aldi"], ["lidl", "Lidl"], ["coop", "Co-op"], ["boots", "Boots"],
      ["marks", "M&S"], ["ms", "M&S"],
    ];
    let foundAny = false;
    for (const [key, displayName] of storeKeys) {
      const price = item[`${key}_price`] ?? item[`${key}Price`] ?? item[key];
      if (price != null && price !== "" && price !== "N/A" && price !== false) {
        const unit = item[`${key}_unit`] ?? item[`${key}Unit`] ?? "";
        results.push({ name: productName, price: formatPrice(price), unit, store: displayName });
        foundAny = true;
      }
    }

    // Structure D: nested object per store name  { "Tesco": { price: "1.50" }, ... }
    if (!foundAny) {
      for (const [key, val] of Object.entries(item)) {
        if (val && typeof val === "object" && (val.price ?? val.p) != null) {
          results.push({
            name: productName,
            price: formatPrice(val.price ?? val.p),
            unit: val.unit ?? val.u ?? "",
            store: key,
          });
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Fallback: scrape prices from HTML response
// ---------------------------------------------------------------------------
function parseTrueviewHtml(html) {
  const results = [];
  const stores = [
    ["Tesco", /tesco/i], ["Sainsbury's", /sainsbury/i], ["ASDA", /asda/i],
    ["Morrisons", /morrison/i], ["Ocado", /ocado/i], ["Waitrose", /waitrose/i],
    ["Iceland", /iceland/i], ["Aldi", /aldi/i], ["Lidl", /lidl/i], ["M&S", /marks.*spencer|m&s/i],
  ];
  for (const [name, rx] of stores) {
    const idx = html.search(rx);
    if (idx === -1) continue;
    const nearby = html.slice(Math.max(0, idx - 50), idx + 200);
    const m = nearby.match(/£([\d.]+)/);
    if (m) results.push({ name: "", price: `£${parseFloat(m[1]).toFixed(2)}`, unit: "", store: name });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function formatPrice(price) {
  const str = String(price).replace(/[^0-9.]/g, "");
  const num = parseFloat(str);
  if (isNaN(num)) return String(price);
  // Looks like whole pence (e.g. 150 → £1.50) when > 20 and no decimal
  if (num > 20 && !String(price).includes(".") && num === Math.floor(num)) {
    return `£${(num / 100).toFixed(2)}`;
  }
  return `£${num.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing ?q= parameter" });

  console.log(`\n${"=".repeat(60)}\nSearching: "${query}"\n${"=".repeat(60)}`);
  try {
    const { ids, nameMap, cookieStr } = await searchTrolley(query);
    if (ids.length === 0) return res.json({ query, results: [] });

    const results = await getTrueviewPrices(ids, nameMap, cookieStr);
    console.log(`  → ${results.length} store prices returned`);
    res.json({ query, results });
  } catch (err) {
    console.error(`  Error: ${err.message}\n${err.stack}`);
    res.status(502).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));