const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const zlib = require("zlib");
const { promisify } = require("util");

const gunzip = promisify(zlib.gunzip);
const app = express();
app.use(cors());

const BASE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-GB,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// ---------------------------------------------------------------------------
// Timeout-aware fetch wrapper — decompresses gzip/br automatically
// ---------------------------------------------------------------------------
async function safeFetch(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      compress: true, // node-fetch handles gzip/br when this is true
      redirect: "follow",
      signal: controller.signal,
    });
    return res;
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
    if (value === "" || value === "deleted") continue;
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
    const incoming = typeof src === "string" ? cookieStrToMap(src) : src;
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
  console.log(`  [session] ${Object.keys(cookieMap).length} cookie(s)`);
  return { cookieMap, cookieStr };
}

// ---------------------------------------------------------------------------
// Strategy 1: Static autosuggest JS file
//
// Trolley pre-generates /autosuggest_<letter>.js (one per first letter).
// Each file is a JS assignment like:
//   var ac_data = [{id:"AB123", name:"...", url:"..."}, ...]
// We fetch it, strip the JS wrapper, and parse the array.
// ---------------------------------------------------------------------------
async function searchViaAutosuggest(query, cookieStr) {
  const letter = query.trim()[0].toLowerCase();
  const url = `https://www.trolley.co.uk/autosuggest_${letter}.js`;
  console.log(`  [autosuggest] GET ${url}`);

  const res = await safeFetch(
    url,
    {
      headers: {
        ...BASE_HEADERS,
        Accept: "*/*",
        Referer: "https://www.trolley.co.uk/",
        Cookie: cookieStr,
      },
    },
    12000
  );
  console.log(`  [autosuggest] status: ${res.status}`);
  if (res.status !== 200) return { ids: [], nameMap: {} };

  const text = await res.text();
  console.log(`  [autosuggest] body length: ${text.length}`);
  if (!text || text.length < 10) return { ids: [], nameMap: {} };

  // Strip JS wrapper — typical patterns:
  //   var ac_data=[...];
  //   window.ac_data=[...];
  //   ac_data=[...];
  const arrayMatch = text.match(/(?:var\s+\w+\s*=\s*|window\.\w+\s*=\s*|\w+\s*=\s*)(\[[\s\S]*\])\s*;?\s*$/);
  if (!arrayMatch) {
    console.log("  [autosuggest] could not find array in JS file");
    return { ids: [], nameMap: {} };
  }

  let items;
  try {
    items = JSON.parse(arrayMatch[1]);
  } catch {
    console.log("  [autosuggest] JSON parse failed");
    return { ids: [], nameMap: {} };
  }

  const queryLower = query.toLowerCase();
  const ID_RX = /^[A-Z]{2,5}[0-9]{2,5}$/;
  const seen = new Set();
  const ids = [];
  const nameMap = {};

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const name = (item.name ?? item.title ?? "").toString();
    // Only keep items that match the query
    if (!name.toLowerCase().includes(queryLower)) continue;

    const rawId = (item.id ?? item.product_id ?? item.sku ?? "").toString().toUpperCase();
    if (ID_RX.test(rawId) && !seen.has(rawId)) {
      seen.add(rawId);
      ids.push(rawId);
      if (name) nameMap[rawId] = name;
    }
  }

  console.log(`  [autosuggest] matched ${ids.length} IDs for query "${query}"`);
  return { ids: ids.slice(0, 10), nameMap };
}

// ---------------------------------------------------------------------------
// Strategy 2: search_suggest.php — returns HTML fragment with product links
// ---------------------------------------------------------------------------
async function searchViaSuggestPhp(query, cookieStr) {
  const url = `https://www.trolley.co.uk/_library/ajax/search_suggest.php?q=${encodeURIComponent(query)}`;
  console.log(`  [suggest.php] GET ${url}`);

  const res = await safeFetch(
    url,
    {
      headers: {
        ...BASE_HEADERS,
        Accept: "text/html, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`,
        Cookie: cookieStr,
      },
    },
    10000
  );
  console.log(`  [suggest.php] status: ${res.status}`);
  if (res.status !== 200) return { ids: [], nameMap: {} };

  const html = await res.text();
  console.log(`  [suggest.php] body length: ${html.length}`);
  return extractIdsFromHtml(html);
}

// ---------------------------------------------------------------------------
// Strategy 3: Scrape the server-rendered search results page directly
// ---------------------------------------------------------------------------
async function searchViaHtmlPage(query, cookieStr) {
  const url = `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`;
  console.log(`  [htmlPage] GET ${url}`);

  const res = await safeFetch(
    url,
    {
      headers: {
        ...BASE_HEADERS,
        Referer: "https://www.trolley.co.uk/",
        Cookie: cookieStr,
      },
    },
    15000
  );
  console.log(`  [htmlPage] status: ${res.status} | final url: ${res.url}`);
  if (res.status !== 200) return { ids: [], nameMap: {} };

  const html = await res.text();
  console.log(`  [htmlPage] body length: ${html.length}`);

  // Capture any new cookies from the search page
  const rawCookies = res.headers.raw()["set-cookie"] ?? [];
  const newCookies = parseSetCookies(rawCookies);
  const merged = mergeCookies(cookieStr, newCookies);
  const updatedCookieStr = cookieMapToStr(merged);

  const extracted = extractIdsFromHtml(html);
  console.log(`  [htmlPage] extracted ${extracted.ids.length} IDs`);
  return { ...extracted, updatedCookieStr };
}

// ---------------------------------------------------------------------------
// Extract product IDs from HTML (SSR page or HTML fragment)
// ---------------------------------------------------------------------------
function extractIdsFromHtml(html) {
  const seen = new Set();
  const ids = [];
  const nameMap = {};

  // /product/<ID>-<slug>/
  for (const m of html.matchAll(/\/product\/([A-Z]{2,5}[0-9]{2,5})(?:-|\/)/g)) {
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

  // data-* attributes as fallback name source
  for (const m of html.matchAll(
    /data-(?:product-)?id="([A-Z]{2,5}[0-9]{2,5})"[^>]*data-name="([^"]{3,100})"/g
  )) {
    if (seen.has(m[1])) nameMap[m[1]] = m[2];
  }

  // Next.js __NEXT_DATA__
  const nextDataMatch = html.match(
    /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/i
  );
  if (nextDataMatch) {
    try {
      const blob = JSON.parse(nextDataMatch[1]);
      walkJson(blob, seen, ids, nameMap);
    } catch { /* ignore */ }
  }

  return { ids: ids.slice(0, 10), nameMap };
}

// Recursively walk a parsed JSON blob looking for product IDs
function walkJson(node, seen, ids, nameMap, depth = 0) {
  if (depth > 12 || node === null || node === undefined) return;
  if (typeof node === "string") {
    const m = node.match(/^([A-Z]{2,5}[0-9]{2,5})$/);
    if (m && !seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walkJson(child, seen, ids, nameMap, depth + 1);
    return;
  }
  if (typeof node === "object") {
    const id = node.id ?? node.product_id ?? node.productId ?? node.sku ?? node.code;
    const name = node.name ?? node.title ?? node.product_name ?? node.productName;
    if (typeof id === "string" && /^[A-Z]{2,5}[0-9]{2,5}$/.test(id) && typeof name === "string") {
      nameMap[id] = name;
    }
    for (const val of Object.values(node)) walkJson(val, seen, ids, nameMap, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Step 2: Fetch prices from trueview.php
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

  const res = await safeFetch(url, { headers });
  const contentType = res.headers.get("content-type") ?? "";
  console.log(`  [trueview] status: ${res.status} | content-type: ${contentType}`);

  const text = await res.text();
  console.log(`  [trueview] body length: ${text.length}`);
  console.log(`  [trueview] body (first 1000 chars):\n${text.slice(0, 1000)}\n---`);

  if (!text || text.trim() === "") {
    console.warn("  [trueview] ⚠ empty response");
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
// Parse trueview JSON
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
        const price = store.price ?? store.current_price ?? store.value ?? store.p;
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
        const price = p.price ?? p.p ?? p.value;
        const storeName = p.store ?? p.retailer ?? p.name ?? p.r ?? "";
        if (price != null && storeName) {
          results.push({ name: productName, price: formatPrice(price), unit: p.unit ?? "", store: storeName });
        }
      }
      continue;
    }

    // Shape C: flat keys — tesco_price, asda_price, …
    const storeKeys = [
      ["tesco", "Tesco"], ["sainsburys", "Sainsbury's"], ["sainsbury", "Sainsbury's"],
      ["asda", "ASDA"], ["morrisons", "Morrisons"], ["morrison", "Morrisons"],
      ["ocado", "Ocado"], ["waitrose", "Waitrose"], ["iceland", "Iceland"],
      ["aldi", "Aldi"], ["lidl", "Lidl"], ["coop", "Co-op"],
      ["boots", "Boots"], ["marks", "M&S"], ["ms", "M&S"],
    ];
    let foundAny = false;
    for (const [key, displayName] of storeKeys) {
      const price = item[`${key}_price`] ?? item[`${key}Price`] ?? item[key];
      if (price != null && price !== "" && price !== "N/A" && price !== false) {
        results.push({ name: productName, price: formatPrice(price), unit: item[`${key}_unit`] ?? item[`${key}Unit`] ?? "", store: displayName });
        foundAny = true;
      }
    }

    // Shape D: nested object per store name — { "Tesco": { price: "1.50" }, … }
    if (!foundAny) {
      for (const [key, val] of Object.entries(item)) {
        if (val && typeof val === "object" && (val.price ?? val.p) != null) {
          results.push({ name: productName, price: formatPrice(val.price ?? val.p), unit: val.unit ?? val.u ?? "", store: key });
        }
      }
    }
  }

  return results;
}

// Fallback: scrape prices from HTML response
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
  if (num > 20 && !String(price).includes(".") && num === Math.floor(num)) {
    return `£${(num / 100).toFixed(2)}`;
  }
  return `£${num.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Main search route — tries strategies in order, stops at first success
// ---------------------------------------------------------------------------
app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing ?q= parameter" });

  console.log(`\n${"=".repeat(60)}\nSearching: "${query}"\n${"=".repeat(60)}`);
  try {
    // Step 0: establish session
    const { cookieStr: sessionCookies } = await getSessionCookies();

    let ids = [];
    let nameMap = {};
    let cookieStr = sessionCookies;

    // Strategy 1: static autosuggest_<letter>.js (fastest, no session needed)
    console.log("\n--- Strategy 1: autosuggest JS file ---");
    ({ ids, nameMap } = await searchViaAutosuggest(query, sessionCookies));

    // Strategy 2: search_suggest.php HTML fragment
    if (ids.length === 0) {
      console.log("\n--- Strategy 2: search_suggest.php ---");
      ({ ids, nameMap } = await searchViaSuggestPhp(query, sessionCookies));
    }

    // Strategy 3: full SSR search results page
    if (ids.length === 0) {
      console.log("\n--- Strategy 3: full HTML search page ---");
      const result = await searchViaHtmlPage(query, sessionCookies);
      ids = result.ids;
      nameMap = result.nameMap;
      if (result.updatedCookieStr) cookieStr = result.updatedCookieStr;
    }

    if (ids.length === 0) {
      console.log("  [flow] no product IDs found — returning empty results");
      return res.json({ query, results: [] });
    }

    console.log(`\n--- Step 2: trueview prices for ${ids.length} IDs ---`);
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
// Debug route — dumps all strategy outputs without calling trueview
// ---------------------------------------------------------------------------
app.get("/debug-search", async (req, res) => {
  const query = req.query.q ?? "milk";
  console.log(`\n[debug-search] query="${query}"`);

  const { cookieStr } = await getSessionCookies();

  const [autosuggest, suggest, page] = await Promise.allSettled([
    searchViaAutosuggest(query, cookieStr),
    searchViaSuggestPhp(query, cookieStr),
    searchViaHtmlPage(query, cookieStr),
  ]);

  res.json({
    query,
    strategies: {
      autosuggest: autosuggest.status === "fulfilled" ? autosuggest.value : { error: autosuggest.reason?.message },
      suggest_php: suggest.status === "fulfilled" ? suggest.value : { error: suggest.reason?.message },
      html_page: page.status === "fulfilled"
        ? { ids: page.value.ids, nameMap: page.value.nameMap }
        : { error: page.reason?.message },
    },
  });
});

// ---------------------------------------------------------------------------
// Debug route — show raw autosuggest JS for a given letter
// ---------------------------------------------------------------------------
app.get("/debug-autosuggest", async (req, res) => {
  const letter = (req.query.letter ?? "m")[0].toLowerCase();
  const from = parseInt(req.query.from ?? "0", 10);
  const len = parseInt(req.query.len ?? "4000", 10);
  const { cookieStr } = await getSessionCookies();
  const url = `https://www.trolley.co.uk/autosuggest_${letter}.js`;
  const r = await safeFetch(url, {
    headers: { ...BASE_HEADERS, Cookie: cookieStr },
  });
  const text = await r.text();

  // List all variable names (handles leading whitespace)
  const varOffsets = [...text.matchAll(/var\s+(\w+)\s*=/g)].map(m => `${m[1]}@${m.index}`);

  res.type("text/plain").send(
    `// ${url}\n// status: ${r.status}\n// length: ${text.length}\n// vars: ${varOffsets.join(", ")}\n// showing chars ${from}–${from + len}\n\n` +
    text.slice(from, from + len)
  );
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));