const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());

const BASE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-GB,en;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// ---------------------------------------------------------------------------
// Timeout-aware fetch wrapper
// ---------------------------------------------------------------------------
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
// Cookie helpers
// ---------------------------------------------------------------------------
function parseSetCookies(rawCookies) {
  const map = {};
  for (const cookie of rawCookies) {
    const pair = cookie.split(";")[0].trim();
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const name = pair.slice(0, eqIdx).trim();
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
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function cookieStrToMap(str) {
  const map = {};
  for (const pair of str.split(";")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (name) map[name] = value;
  }
  return map;
}

function mergeCookies(...sources) {
  let map = {};
  for (const src of sources) {
    if (!src) continue;
    const incoming =
      typeof src === "string" ? cookieStrToMap(src) : src;
    map = { ...map, ...incoming };
  }
  return map;
}

// ---------------------------------------------------------------------------
// Step 0: Visit homepage to establish a real browser-like session
// ---------------------------------------------------------------------------
async function getSessionCookies() {
  const url = "https://www.trolley.co.uk/";
  console.log(`  [session] GET ${url}`);

  const res = await safeFetch(url, {
    headers: { ...BASE_HEADERS, Referer: "https://www.google.com/" },
  });
  console.log(`  [session] status: ${res.status}`);

  const rawCookies = res.headers.raw()["set-cookie"] ?? [];
  const cookieMap = parseSetCookies(rawCookies);
  const cookieStr = cookieMapToStr(cookieMap);
  console.log(
    `  [session] ${Object.keys(cookieMap).length} cookie(s): ${cookieStr.slice(0, 120)}`
  );
  return { cookieMap, cookieStr };
}

// ---------------------------------------------------------------------------
// Step 1a: Hit the search page to get search-page cookies (simulates a real
//           browse flow before we fire the XHR search API call)
// ---------------------------------------------------------------------------
async function visitSearchPage(query, sessionCookies) {
  const url = `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`;
  console.log(`  [searchPage] GET ${url}`);

  const res = await safeFetch(url, {
    headers: {
      ...BASE_HEADERS,
      Referer: "https://www.trolley.co.uk/",
      Cookie: sessionCookies,
    },
  });
  console.log(`  [searchPage] status: ${res.status}`);

  const rawCookies = res.headers.raw()["set-cookie"] ?? [];
  const newCookies = parseSetCookies(rawCookies);
  const merged = mergeCookies(sessionCookies, newCookies);
  const cookieStr = cookieMapToStr(merged);
  console.log(
    `  [searchPage] merged ${Object.keys(merged).length} cookie(s): ${cookieStr.slice(0, 120)}`
  );

  // While we have the HTML, opportunistically extract product IDs in case
  // the XHR API fails. Client-side rendered pages may have preloaded JSON
  // embedded in a <script> tag (Next.js __NEXT_DATA__, Nuxt __NUXT__, etc.)
  const html = await res.text();
  const preloadedIds = extractIdsFromHtml(html);
  if (preloadedIds.ids.length > 0) {
    console.log(
      `  [searchPage] found ${preloadedIds.ids.length} preloaded IDs in HTML`
    );
  }

  return { cookieStr, preloadedIds };
}

// ---------------------------------------------------------------------------
// Extract product IDs and names from any HTML source (handles SSR preload
// blobs embedded in Next.js / Nuxt / plain script tags as well as /product/ URLs)
// ---------------------------------------------------------------------------
function extractIdsFromHtml(html) {
  const seen = new Set();
  const ids = [];
  const nameMap = {};

  // Primary: /product/<ID>-<slug>/ URL paths
  for (const m of html.matchAll(
    /\/product\/([A-Z]{2,5}[0-9]{2,5})(?:-|\/)/g
  )) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  // Slug-derived names
  for (const m of html.matchAll(
    /\/product\/([A-Z]{2,5}[0-9]{2,5})-([^/"]{3,120}?)(?:\/|")/g
  )) {
    const id = m[1];
    if (!nameMap[id]) {
      nameMap[id] = m[2]
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .slice(0, 80);
    }
  }

  // data-* attributes as a fallback name source (IDs already validated above)
  for (const m of html.matchAll(
    /data-(?:product-)?id="([A-Z]{2,5}[0-9]{2,5})"[^>]*data-name="([^"]{3,100})"/g
  )) {
    if (seen.has(m[1])) nameMap[m[1]] = m[2];
  }

  // Embedded JSON blobs — Next.js __NEXT_DATA__, Nuxt __NUXT__, or plain
  // window.__STATE__ / window.__INITIAL_STATE__ patterns
  const jsonBlobRx =
    /<script[^>]*>\s*(?:window\.__[A-Z_]+=|var __[A-Z_]+=)?\s*(\{[\s\S]{200,}?\})\s*(?:;)?\s*<\/script>/gi;
  for (const scriptMatch of html.matchAll(jsonBlobRx)) {
    try {
      const blob = JSON.parse(scriptMatch[1]);
      walkJson(blob, seen, ids, nameMap);
    } catch {
      // not valid JSON — skip
    }
  }

  // Next.js specific: <script id="__NEXT_DATA__" type="application/json">
  const nextDataMatch = html.match(
    /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/i
  );
  if (nextDataMatch) {
    try {
      const blob = JSON.parse(nextDataMatch[1]);
      walkJson(blob, seen, ids, nameMap);
    } catch {
      // ignore
    }
  }

  return { ids: ids.slice(0, 10), nameMap };
}

// Recursively walk a parsed JSON blob looking for product ID patterns
function walkJson(node, seen, ids, nameMap, depth = 0) {
  if (depth > 12 || node === null || node === undefined) return;
  if (typeof node === "string") {
    const m = node.match(/^([A-Z]{2,5}[0-9]{2,5})$/);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      ids.push(m[1]);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walkJson(child, seen, ids, nameMap, depth + 1);
    return;
  }
  if (typeof node === "object") {
    // If the object looks like a product record, grab name
    const id =
      node.id ?? node.product_id ?? node.productId ?? node.sku ?? node.code;
    const name = node.name ?? node.title ?? node.product_name ?? node.productName;
    if (
      typeof id === "string" &&
      /^[A-Z]{2,5}[0-9]{2,5}$/.test(id) &&
      typeof name === "string"
    ) {
      nameMap[id] = name;
    }
    for (const val of Object.values(node)) {
      walkJson(val, seen, ids, nameMap, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 1b: Call Trolley's internal XHR search API
//
// The browser SPA fires an XHR/fetch to retrieve search results as JSON.
// Common endpoint patterns (we try each in order):
//   1. /api/search?q=…               — simple REST
//   2. /api/v1/search?q=…            — versioned REST
//   3. /_library/ajax/search.php?q=… — legacy AJAX handler (same origin as trueview.php)
//   4. /search.json?q=…              — Shopify-style
//
// We send the same cookies and XHR headers the browser would send.
// ---------------------------------------------------------------------------
async function callSearchApi(query, cookieStr) {
  const xhrHeaders = {
    ...BASE_HEADERS,
    Accept: "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    Referer: `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`,
    Cookie: cookieStr,
  };

  const candidates = [
    `https://www.trolley.co.uk/api/search?q=${encodeURIComponent(query)}&limit=20`,
    `https://www.trolley.co.uk/api/v1/search?q=${encodeURIComponent(query)}&limit=20`,
    `https://www.trolley.co.uk/api/v2/search?q=${encodeURIComponent(query)}&limit=20`,
    `https://www.trolley.co.uk/_library/ajax/search.php?q=${encodeURIComponent(query)}&limit=20`,
    `https://www.trolley.co.uk/search.json?q=${encodeURIComponent(query)}&limit=20`,
    `https://www.trolley.co.uk/_library/ajax/ac.php?q=${encodeURIComponent(query)}`, // autocomplete
    `https://www.trolley.co.uk/api/products/search?query=${encodeURIComponent(query)}`,
    `https://www.trolley.co.uk/api/search?query=${encodeURIComponent(query)}`,
  ];

  for (const url of candidates) {
    console.log(`  [searchApi] trying: ${url}`);
    try {
      const res = await safeFetch(url, { headers: xhrHeaders }, 8000);
      console.log(
        `  [searchApi] status: ${res.status} | content-type: ${res.headers.get("content-type") ?? "?"}`
      );
      if (res.status !== 200) continue;

      const text = await res.text();
      if (!text || text.trim() === "") continue;

      // Must be JSON (or JSON-like) to be useful
      if (!text.trim().startsWith("{") && !text.trim().startsWith("["))
        continue;

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        continue;
      }

      const { ids, nameMap } = extractIdsFromJson(data);
      if (ids.length > 0) {
        console.log(
          `  [searchApi] ✓ ${url} returned ${ids.length} IDs: ${ids.slice(0, 5).join(", ")}`
        );
        return { ids: ids.slice(0, 10), nameMap };
      }

      console.log(`  [searchApi] responded with JSON but 0 IDs extracted — sample: ${text.slice(0, 300)}`);
    } catch (err) {
      console.log(`  [searchApi] error: ${err.message}`);
    }
  }

  console.log("  [searchApi] all candidates exhausted — no IDs found via API");
  return { ids: [], nameMap: {} };
}

// ---------------------------------------------------------------------------
// Extract product IDs from a parsed JSON search-API response
// Handles multiple possible shapes:
//   { products: [{id, name}, …] }
//   { results: [{id, name}, …] }
//   { data: [{id, name}, …] }
//   [ {id, name}, … ]  (bare array)
//   { hits: [{objectID, …}, …] }  (Algolia)
// ---------------------------------------------------------------------------
function extractIdsFromJson(data) {
  const seen = new Set();
  const ids = [];
  const nameMap = {};

  const ID_RX = /^[A-Z]{2,5}[0-9]{2,5}$/;

  function processItem(item) {
    if (!item || typeof item !== "object") return;
    const rawId =
      item.id ?? item.product_id ?? item.productId ??
      item.sku ?? item.code ?? item.objectID ?? item.objectId;
    const name =
      item.name ?? item.title ?? item.product_name ??
      item.productName ?? item.label ?? "";
    if (typeof rawId === "string" && ID_RX.test(rawId)) {
      if (!seen.has(rawId)) {
        seen.add(rawId);
        ids.push(rawId);
      }
      if (name && !nameMap[rawId]) nameMap[rawId] = name;
    }
  }

  // Determine the array of product records from common wrapper shapes
  const arrayKeys = ["products", "results", "data", "items", "hits", "records"];
  let records = Array.isArray(data) ? data : null;
  if (!records) {
    for (const key of arrayKeys) {
      if (Array.isArray(data[key])) {
        records = data[key];
        break;
      }
    }
  }

  if (records) {
    for (const item of records) processItem(item);
  }

  // If still nothing, walk the whole structure
  if (ids.length === 0) {
    walkJson(data, seen, ids, nameMap);
  }

  return { ids, nameMap };
}

// ---------------------------------------------------------------------------
// Step 2: Fetch prices from trueview.php with a valid session cookie
// ---------------------------------------------------------------------------
async function getTrueviewPrices(ids, nameMap = {}, cookieStr = "") {
  if (ids.length === 0) return [];

  const idParam = ids.join("|");
  const posParam = ids.map((_, i) => i + 1).join("|");
  const url =
    `https://www.trolley.co.uk/_library/ajax/trueview.php` +
    `?product_id=${encodeURIComponent(idParam)}&p=${encodeURIComponent(posParam)}&sid=`;

  const headers = {
    ...BASE_HEADERS,
    Accept: "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    Referer: "https://www.trolley.co.uk/search/",
    ...(cookieStr ? { Cookie: cookieStr } : {}),
  };

  console.log(`  [trueview] fetching ${ids.length} products: ${ids.join(", ")}`);
  console.log(`  [trueview] Cookie: ${cookieStr.slice(0, 120)}`);

  const res = await safeFetch(url, { headers });
  const contentType = res.headers.get("content-type") ?? "";
  console.log(
    `  [trueview] status: ${res.status} | content-type: ${contentType}`
  );

  const text = await res.text();
  console.log(`  [trueview] body length: ${text.length}`);
  console.log(`  [trueview] body (first 1000 chars):\n${text.slice(0, 1000)}\n---`);

  if (!text || text.trim() === "") {
    console.warn(
      "  [trueview] ⚠ empty response — session cookie may be insufficient or endpoint has moved"
    );
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
  console.log(
    `  [trueview] JSON sample: ${JSON.stringify(data).slice(0, 600)}`
  );

  const items = Array.isArray(data)
    ? data.map((v, i) => [String(i), v])
    : Object.entries(data);

  for (const [productId, item] of items) {
    if (!item || typeof item !== "object") continue;

    const productName =
      item.name ??
      item.title ??
      item.product_name ??
      nameMap[productId] ??
      productId ??
      "";

    // Shape A: item.stores = [{store, price, unit_price}, ...]
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

    // Shape B: item.prices = [{store, price}, ...]
    if (Array.isArray(item.prices)) {
      for (const p of item.prices) {
        const price = p.price ?? p.p ?? p.value;
        const storeName = p.store ?? p.retailer ?? p.name ?? p.r ?? "";
        if (price != null && storeName) {
          results.push({
            name: productName,
            price: formatPrice(price),
            unit: p.unit ?? "",
            store: storeName,
          });
        }
      }
      continue;
    }

    // Shape C: flat keys — tesco_price, asda_price, …
    const storeKeys = [
      ["tesco", "Tesco"],
      ["sainsburys", "Sainsbury's"],
      ["sainsbury", "Sainsbury's"],
      ["asda", "ASDA"],
      ["morrisons", "Morrisons"],
      ["morrison", "Morrisons"],
      ["ocado", "Ocado"],
      ["waitrose", "Waitrose"],
      ["iceland", "Iceland"],
      ["aldi", "Aldi"],
      ["lidl", "Lidl"],
      ["coop", "Co-op"],
      ["boots", "Boots"],
      ["marks", "M&S"],
      ["ms", "M&S"],
    ];
    let foundAny = false;
    for (const [key, displayName] of storeKeys) {
      const price = item[`${key}_price`] ?? item[`${key}Price`] ?? item[key];
      if (price != null && price !== "" && price !== "N/A" && price !== false) {
        const unit = item[`${key}_unit`] ?? item[`${key}Unit`] ?? "";
        results.push({
          name: productName,
          price: formatPrice(price),
          unit,
          store: displayName,
        });
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
    ["Tesco", /tesco/i],
    ["Sainsbury's", /sainsbury/i],
    ["ASDA", /asda/i],
    ["Morrisons", /morrison/i],
    ["Ocado", /ocado/i],
    ["Waitrose", /waitrose/i],
    ["Iceland", /iceland/i],
    ["Aldi", /aldi/i],
    ["Lidl", /lidl/i],
    ["M&S", /marks.*spencer|m&s/i],
  ];
  for (const [name, rx] of stores) {
    const idx = html.search(rx);
    if (idx === -1) continue;
    const nearby = html.slice(Math.max(0, idx - 50), idx + 200);
    const m = nearby.match(/£([\d.]+)/);
    if (m)
      results.push({
        name: "",
        price: `£${parseFloat(m[1]).toFixed(2)}`,
        unit: "",
        store: name,
      });
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
    // Step 0: establish a real browser-like session
    const { cookieStr: sessionCookies } = await getSessionCookies();

    // Step 1a: visit the search page (simulates real browse flow, picks up
    //          search-page cookies, and opportunistically grabs any SSR product data)
    const { cookieStr, preloadedIds } = await visitSearchPage(query, sessionCookies);

    let ids, nameMap;

    if (preloadedIds.ids.length > 0) {
      // Lucky path: SSR gave us the IDs directly in the HTML
      console.log("  [flow] using SSR-preloaded IDs");
      ({ ids, nameMap } = preloadedIds);
    } else {
      // Normal path: call the XHR search API the browser JS would call
      console.log("  [flow] falling back to XHR search API");
      ({ ids, nameMap } = await callSearchApi(query, cookieStr));
    }

    if (ids.length === 0) {
      console.log("  [flow] no product IDs found — returning empty results");
      return res.json({ query, results: [] });
    }

    // Step 2: fetch cross-retailer prices
    const results = await getTrueviewPrices(ids, nameMap, cookieStr);
    console.log(`  → ${results.length} store prices returned`);
    res.json({ query, results });
  } catch (err) {
    console.error(`  Error: ${err.message}\n${err.stack}`);
    res.status(502).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Debug route — dumps raw search API responses so you can identify the
// correct endpoint without having to open DevTools manually
// ---------------------------------------------------------------------------
app.get("/debug-search", async (req, res) => {
  const query = req.query.q ?? "milk";
  console.log(`\n[debug-search] query="${query}"`);

  const { cookieStr: sessionCookies } = await getSessionCookies();
  const { cookieStr } = await visitSearchPage(query, sessionCookies);

  const xhrHeaders = {
    ...BASE_HEADERS,
    Accept: "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    Referer: `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`,
    Cookie: cookieStr,
  };

  const candidates = [
    `https://www.trolley.co.uk/api/search?q=${encodeURIComponent(query)}&limit=20`,
    `https://www.trolley.co.uk/api/v1/search?q=${encodeURIComponent(query)}&limit=20`,
    `https://www.trolley.co.uk/api/v2/search?q=${encodeURIComponent(query)}&limit=20`,
    `https://www.trolley.co.uk/_library/ajax/search.php?q=${encodeURIComponent(query)}&limit=20`,
    `https://www.trolley.co.uk/search.json?q=${encodeURIComponent(query)}&limit=20`,
    `https://www.trolley.co.uk/_library/ajax/ac.php?q=${encodeURIComponent(query)}`,
    `https://www.trolley.co.uk/api/products/search?query=${encodeURIComponent(query)}`,
    `https://www.trolley.co.uk/api/search?query=${encodeURIComponent(query)}`,
  ];

  const report = [];
  for (const url of candidates) {
    try {
      const r = await safeFetch(url, { headers: xhrHeaders }, 8000);
      const text = await r.text();
      report.push({
        url,
        status: r.status,
        contentType: r.headers.get("content-type"),
        bodyLength: text.length,
        bodyPreview: text.slice(0, 500),
      });
    } catch (err) {
      report.push({ url, error: err.message });
    }
  }

  res.json({ query, cookiePreview: cookieStr.slice(0, 120), candidates: report });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));