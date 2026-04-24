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
// Cookie helper — parse Set-Cookie headers into a name→value map,
// silently dropping any already-expired cookies (value === "" or "deleted")
// ---------------------------------------------------------------------------
function parseSetCookies(rawCookies) {
  const map = {};
  for (const cookie of rawCookies) {
    const pair = cookie.split(";")[0].trim();
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const name  = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (value === "" || value === "deleted") {
      console.log(`  [cookies] skipping expired: ${name}`);
      continue;
    }
    map[name] = value;
  }
  return map;
}

function cookieMapToStr(map) {
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join("; ");
}

function cookieStrToMap(str) {
  const map = {};
  for (const pair of str.split(";")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const name  = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (name) map[name] = value;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Step 0: Visit the homepage to establish a real session
//
// Trolley's trueview.php validates that the caller went through the normal
// browse flow. Without a proper session cookie (set on the homepage, not the
// search page) it returns an empty body and we get no prices.
// ---------------------------------------------------------------------------
async function getSessionCookies() {
  const url = "https://www.trolley.co.uk/";
  console.log(`  [session] GET ${url}`);

  const res = await safeFetch(url, {
    headers: { ...BASE_HEADERS, "Referer": "https://www.google.com/" },
  });
  console.log(`  [session] status: ${res.status}`);

  const rawCookies = res.headers.raw()["set-cookie"] ?? [];
  const cookieMap  = parseSetCookies(rawCookies);
  const cookieStr  = cookieMapToStr(cookieMap);
  console.log(`  [session] ${Object.keys(cookieMap).length} cookie(s): ${cookieStr.slice(0, 120)}`);
  return cookieStr;
}

// ---------------------------------------------------------------------------
// Step 1: Search — using the session cookie from Step 0
//
// Product IDs are extracted ONLY from /product/<ID>-<slug>/ URL paths.
// This is the only source that is guaranteed to contain real Trolley IDs.
// Every other approach (data-* attributes, bare-word regex) also matches
// random HTML tokens and produces garbage IDs like MOZ184 or ZKW136.
// ---------------------------------------------------------------------------
async function searchTrolley(query, sessionCookies = "") {
  const url = `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`;
  console.log(`  [search] GET ${url}`);

  const res = await safeFetch(url, {
    headers: {
      ...BASE_HEADERS,
      "Referer": "https://www.trolley.co.uk/",
      ...(sessionCookies ? { "Cookie": sessionCookies } : {}),
    },
  });
  console.log(`  [search] status: ${res.status}`);

  // Merge homepage cookies → search-page cookies (search-page wins on conflict,
  // but we keep homepage-only cookies that the search page doesn't re-issue)
  const baseCookieMap   = cookieStrToMap(sessionCookies);
  const rawSearchCookies = res.headers.raw()["set-cookie"] ?? [];
  const searchCookieMap  = parseSetCookies(rawSearchCookies);
  const mergedMap        = { ...baseCookieMap, ...searchCookieMap };
  const cookieStr        = cookieMapToStr(mergedMap);
  console.log(`  [search] merged ${Object.keys(mergedMap).length} cookie(s): ${cookieStr.slice(0, 120)}`);

  const html = await res.text();

  // ── Extract product IDs strictly from /product/ URL paths ─────────────
  //
  // Pattern: /product/ABC123-rest-of-slug/  (ID = letters then digits)
  // We do NOT fall back to data-* or bare-word matches. If the search page
  // contains no /product/ URLs there simply are no results for this query.
  const seen    = new Set();
  const ids     = [];
  const nameMap = {};

  for (const m of html.matchAll(/\/product\/([A-Z]{2,5}[0-9]{2,5})(?:-|\/)/g)) {
    const id = m[1];
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }

  // ── Derive product names from the slug after the ID ───────────────────
  // e.g. /product/EGG001-free-range-large-eggs/ → "Free Range Large Eggs"
  // A real data-name attribute (if present) overwrites the slug-derived name.
  for (const m of html.matchAll(/\/product\/([A-Z]{2,5}[0-9]{2,5})-([^/"]{3,120}?)(?:\/|")/g)) {
    const id = m[1];
    if (!nameMap[id]) {
      nameMap[id] = m[2]
        .replace(/-/g, " ")
        .replace(/\b\w/g, c => c.toUpperCase())
        .slice(0, 80);
    }
  }
  for (const m of html.matchAll(/data-(?:product-)?id="([A-Z]{2,5}[0-9]{2,5})"[^>]*data-name="([^"]{3,100})"/g)) {
    nameMap[m[1]] = m[2];
  }

  console.log(`  [search] found ${ids.length} IDs (first 5: ${ids.slice(0, 5).join(", ")})`);
  return { ids: ids.slice(0, 10), nameMap, cookieStr };
}

// ---------------------------------------------------------------------------
// Step 2: Fetch prices from trueview.php with a valid session cookie
// ---------------------------------------------------------------------------
async function getTrueviewPrices(ids, nameMap = {}, cookieStr = "") {
  if (ids.length === 0) return [];

  const idParam  = ids.join("|");
  const posParam = ids.map((_, i) => i + 1).join("|");
  const url = `https://www.trolley.co.uk/_library/ajax/trueview.php` +
    `?product_id=${encodeURIComponent(idParam)}&p=${encodeURIComponent(posParam)}&sid=`;

  const headers = {
    ...BASE_HEADERS,
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://www.trolley.co.uk/search/",
    ...(cookieStr ? { "Cookie": cookieStr } : {}),
  };

  console.log(`  [trueview] fetching ${ids.length} products`);
  console.log(`  [trueview] Cookie: ${cookieStr.slice(0, 120)}`);

  const res = await safeFetch(url, { headers });
  const contentType = res.headers.get("content-type") ?? "";
  console.log(`  [trueview] status: ${res.status} | content-type: ${contentType}`);

  const text = await res.text();
  console.log(`  [trueview] body length: ${text.length}`);
  console.log(`  [trueview] body (first 1000 chars):\n${text.slice(0, 1000)}\n---`);

  if (!text || text.trim() === "") {
    console.warn("  [trueview] ⚠ empty response — session cookie may be insufficient or endpoint has moved");
    return [];
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.warn("  [trueview] not JSON — trying HTML fallback parser");
    return parseTrueviewHtml(text);
  }

  return parseTrueviewJson(data, nameMap);
}

// ---------------------------------------------------------------------------
// Parse trueview JSON — handles multiple possible response shapes
// ---------------------------------------------------------------------------
function parseTrueviewJson(data, nameMap = {}) {
  const results = [];
  console.log(`  [trueview] JSON sample: ${JSON.stringify(data).slice(0, 600)}`);

  const items = Array.isArray(data)
    ? data.map((v, i) => [String(i), v])
    : Object.entries(data);

  for (const [productId, item] of items) {
    if (!item || typeof item !== "object") continue;

    const productName =
      item.name ?? item.title ?? item.product_name ?? nameMap[productId] ?? productId ?? "";

    // Shape A: item.stores = [{store, price, unit_price}, ...]
    if (Array.isArray(item.stores)) {
      for (const store of item.stores) {
        const price     = store.price ?? store.current_price ?? store.value ?? store.p;
        const storeName = store.store ?? store.retailer ?? store.name ?? store.r ?? "";
        if (price != null && price !== "" && storeName) {
          results.push({ name: productName, price: formatPrice(price), unit: store.unit_price ?? store.u ?? "", store: storeName });
        }
      }
      continue;
    }

    // Shape B: item.prices = [{store, price}, ...]
    if (Array.isArray(item.prices)) {
      for (const p of item.prices) {
        const price     = p.price ?? p.p ?? p.value;
        const storeName = p.store ?? p.retailer ?? p.name ?? p.r ?? "";
        if (price != null && storeName) {
          results.push({ name: productName, price: formatPrice(price), unit: p.unit ?? "", store: storeName });
        }
      }
      continue;
    }

    // Shape C: flat keys — tesco_price, asda_price, …
    const storeKeys = [
      ["tesco",       "Tesco"],
      ["sainsburys",  "Sainsbury's"], ["sainsbury", "Sainsbury's"],
      ["asda",        "ASDA"],
      ["morrisons",   "Morrisons"],  ["morrison",  "Morrisons"],
      ["ocado",       "Ocado"],
      ["waitrose",    "Waitrose"],
      ["iceland",     "Iceland"],
      ["aldi",        "Aldi"],
      ["lidl",        "Lidl"],
      ["coop",        "Co-op"],
      ["boots",       "Boots"],
      ["marks",       "M&S"],        ["ms",        "M&S"],
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

    // Shape D: nested object per store name — { "Tesco": { price: "1.50" }, … }
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
// Fallback: scrape prices from an HTML response (trueview returning a page)
// ---------------------------------------------------------------------------
function parseTrueviewHtml(html) {
  const results = [];
  const stores = [
    ["Tesco",         /tesco/i],
    ["Sainsbury's",   /sainsbury/i],
    ["ASDA",          /asda/i],
    ["Morrisons",     /morrison/i],
    ["Ocado",         /ocado/i],
    ["Waitrose",      /waitrose/i],
    ["Iceland",       /iceland/i],
    ["Aldi",          /aldi/i],
    ["Lidl",          /lidl/i],
    ["M&S",           /marks.*spencer|m&s/i],
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
  // Whole-pence encoding (e.g. 150 → £1.50) when value > 20 with no decimal point
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
    // Step 0: establish a real browser-like session before anything else
    const sessionCookies = await getSessionCookies();

    // Step 1: search (carries the session cookie forward)
    const { ids, nameMap, cookieStr } = await searchTrolley(query, sessionCookies);
    if (ids.length === 0) return res.json({ query, results: [] });

    // Step 2: fetch prices
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