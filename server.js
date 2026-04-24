const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Headers that look like a real browser visit
// ---------------------------------------------------------------------------
const BASE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "KHTML, like Gecko Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-GB,en;q=0.9",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
};

// ---------------------------------------------------------------------------
// Fetch helper with timeout + abort
// ---------------------------------------------------------------------------
async function safeFetch(url, extraHeaders = {}, timeout = 20000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { ...BASE_HEADERS, ...extraHeaders },
      redirect: "follow",
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Extract cookies from a response to reuse in subsequent requests
// ---------------------------------------------------------------------------
function extractCookies(res) {
  const raw = res.headers.raw()["set-cookie"] || [];
  return raw
    .map((c) => c.split(";")[0])
    .filter((c) => c && !c.includes("deleted"))
    .join("; ");
}

// ---------------------------------------------------------------------------
// MAIN: scrape prices from __NEXT_DATA__ embedded JSON on the search page
//
// Trolley.co.uk is a Next.js app — all product + price data is embedded in a
// <script id="__NEXT_DATA__"> tag as a JSON blob. We parse that instead of
// calling the internal trueview AJAX endpoint (which requires a live session
// cookie that we can't easily obtain server-side).
// ---------------------------------------------------------------------------
async function scrapeSearchPage(query, cookieStr) {
  const url = `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`;

  const res = await safeFetch(url, {
    Referer: "https://www.trolley.co.uk/",
    Cookie: cookieStr,
  });

  const html = await res.text();
  console.log(`  HTML length for "${query}":`, html.length);

  // ── Strategy 1: __NEXT_DATA__ JSON blob ──────────────────────────────────
  const nextDataMatch = html.match(
    /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
  );

  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      const products = extractFromNextData(nextData, query);
      if (products.length) {
        console.log(`  ✅ __NEXT_DATA__: found ${products.length} results`);
        return products;
      }
    } catch (e) {
      console.log("  ⚠️  __NEXT_DATA__ parse error:", e.message);
    }
  }

  // ── Strategy 2: JSON-LD (schema.org Product) ─────────────────────────────
  const jsonLdResults = extractFromJsonLd(html, query);
  if (jsonLdResults.length) {
    console.log(`  ✅ JSON-LD: found ${jsonLdResults.length} results`);
    return jsonLdResults;
  }

  // ── Strategy 3: inline price patterns in the raw HTML ────────────────────
  const inlineResults = extractFromInlinePatterns(html, query);
  if (inlineResults.length) {
    console.log(`  ✅ Inline patterns: found ${inlineResults.length} results`);
    return inlineResults;
  }

  console.log(`  ❌ No prices found for "${query}"`);
  return [];
}

// ---------------------------------------------------------------------------
// Strategy 1: walk the Next.js page props tree looking for product/price data
// ---------------------------------------------------------------------------
function extractFromNextData(nextData, query) {
  const results = [];

  // Recursively search for arrays that look like product listings
  function walk(obj, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 15) return;

    // Look for items that have a name + prices object or a supermarkets array
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (isProductItem(item)) {
          const extracted = extractProductPrices(item, query);
          results.push(...extracted);
        } else {
          walk(item, depth + 1);
        }
      }
    } else {
      for (const val of Object.values(obj)) {
        walk(val, depth + 1);
      }
    }
  }

  walk(nextData);
  return results;
}

function isProductItem(item) {
  if (!item || typeof item !== "object") return false;
  // Must have a name and some kind of pricing data
  return (
    item.name &&
    (item.supermarkets ||
      item.prices ||
      item.lowestPrice != null ||
      item.cheapestSupermarket)
  );
}

function extractProductPrices(item, query) {
  const productName = item.name || query;
  const results = [];

  // supermarkets array: [{ name, price, url, ... }]
  if (Array.isArray(item.supermarkets)) {
    for (const s of item.supermarkets) {
      const price = s.price ?? s.currentPrice ?? s.listPrice;
      if (price == null || !s.name) continue;
      results.push({
        name: productName,
        store: normaliseStoreName(s.name),
        price: formatPrice(price),
        unit: s.unitPrice || s.unit_price || "",
        priceNumeric: toNumber(price),
      });
    }
  }

  // prices object: { tesco: 1.50, sainsburys: 1.60, ... }
  if (item.prices && typeof item.prices === "object") {
    for (const [store, price] of Object.entries(item.prices)) {
      if (price == null) continue;
      results.push({
        name: productName,
        store: normaliseStoreName(store),
        price: formatPrice(price),
        unit: "",
        priceNumeric: toNumber(price),
      });
    }
  }

  // Single cheapest price fallback
  if (!results.length && item.lowestPrice != null && item.cheapestSupermarket) {
    results.push({
      name: productName,
      store: normaliseStoreName(item.cheapestSupermarket),
      price: formatPrice(item.lowestPrice),
      unit: item.unitPrice || "",
      priceNumeric: toNumber(item.lowestPrice),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Strategy 2: JSON-LD schema.org/Product blocks
// ---------------------------------------------------------------------------
function extractFromJsonLd(html, query) {
  const results = [];
  const matches = html.matchAll(
    /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g
  );

  for (const m of matches) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const d of items) {
        if (d["@type"] === "Product" || d["@type"] === "ItemList") {
          extractJsonLdProduct(d, query, results);
        }
      }
    } catch (_) {}
  }
  return results;
}

function extractJsonLdProduct(d, query, results) {
  const name = d.name || query;

  if (d.offers) {
    const offers = Array.isArray(d.offers) ? d.offers : [d.offers];
    for (const o of offers) {
      const price = o.price ?? o.lowPrice;
      if (price == null) continue;
      results.push({
        name,
        store: normaliseStoreName(o.seller?.name || o.offeredBy || "Unknown"),
        price: formatPrice(price),
        unit: "",
        priceNumeric: toNumber(price),
      });
    }
  }

  if (d.itemListElement) {
    for (const el of d.itemListElement) {
      extractJsonLdProduct(el.item || el, query, results);
    }
  }
}

// ---------------------------------------------------------------------------
// Strategy 3: price patterns directly in the HTML markup
//  trolley embeds prices as  data-price="1.50" data-store="Tesco"  etc.
// ---------------------------------------------------------------------------
function extractFromInlinePatterns(html, query) {
  const results = [];
  const seen = new Set();

  // Pattern: data-store="Tesco" ... data-price="1.50"
  const storePrice = [
    ...html.matchAll(/data-store="([^"]+)"[^>]*data-price="([\d.]+)"/g),
    ...html.matchAll(/data-price="([\d.]+)"[^>]*data-store="([^"]+)"/g),
  ];

  for (const m of storePrice) {
    const [, a, b] = m;
    const store = a.includes(".") ? b : a;
    const price = a.includes(".") ? a : b;
    const key = `${store}-${price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      name: query,
      store: normaliseStoreName(store),
      price: formatPrice(price),
      unit: "",
      priceNumeric: toNumber(price),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const STORE_MAP = {
  tesco: "Tesco",
  sainsburys: "Sainsbury's",
  "sainsbury's": "Sainsbury's",
  asda: "Asda",
  morrisons: "Morrisons",
  waitrose: "Waitrose",
  ocado: "Ocado",
  aldi: "Aldi",
  lidl: "Lidl",
  coop: "Co-op",
  "co-op": "Co-op",
  iceland: "Iceland",
  marks: "M&S",
  "m&s": "M&S",
};

function normaliseStoreName(raw) {
  const key = String(raw).toLowerCase().trim();
  return STORE_MAP[key] || raw;
}

function formatPrice(p) {
  const n = toNumber(p);
  if (n == null) return String(p);
  return `£${n.toFixed(2)}`;
}

function toNumber(p) {
  const n = parseFloat(String(p).replace(/[^\d.]/g, ""));
  return isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// Find the cheapest store across a flat results array
// ---------------------------------------------------------------------------
function findCheapest(results) {
  let cheapest = null;
  for (const r of results) {
    if (r.priceNumeric == null) continue;
    if (!cheapest || r.priceNumeric < cheapest.priceNumeric) cheapest = r;
  }
  if (!cheapest) return null;
  return { store: cheapest.store, price: cheapest.price, name: cheapest.name, unit: cheapest.unit };
}

// ---------------------------------------------------------------------------
// Shared: get session cookie from homepage
// ---------------------------------------------------------------------------
async function getSessionCookie() {
  const home = await safeFetch("https://www.trolley.co.uk/", {
    Referer: "https://www.google.com/",
  });
  return extractCookies(home);
}

// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------
app.get("/", (_, res) => {
  res.send("Grocery price API. Use GET /search?q=milk or POST /compare { items:[...] }");
});

// GET /search?q=milk  — returns all prices for a single item
app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing ?q= param" });

  try {
    console.log("\n== GET /search ==", query);
    const cookieStr = await getSessionCookie();
    const results = await scrapeSearchPage(query, cookieStr);

    // Strip the internal priceNumeric field before returning
    const clean = results.map(({ priceNumeric: _, ...r }) => r);
    res.json({ query, results: clean });
  } catch (err) {
    console.error("ERROR /search:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /compare { items: ["milk", "bread"] }  or  { q: "milk" }
// Returns per-item results + cheapest store
app.post("/compare", async (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.items)
    ? body.items
    : body.q
    ? [body.q]
    : [];

  if (!items.length)
    return res.status(400).json({ error: 'Send { "items": ["milk","bread"] } or { "q": "milk" }' });

  try {
    console.log("\n== POST /compare ==", items);
    const cookieStr = await getSessionCookie();
    const itemResults = [];

    for (const q of items) {
      console.log("  Searching:", q);
      try {
        const results = await scrapeSearchPage(q, cookieStr);
        const cheapest = findCheapest(results);
        const clean = results.map(({ priceNumeric: _, ...r }) => r);
        itemResults.push({ query: q, results: clean, cheapest });
      } catch (err) {
        console.error("  Error for", q, err.message);
        itemResults.push({ query: q, results: [], cheapest: null, error: err.message });
      }
    }

    res.json({ items: itemResults });
  } catch (err) {
    console.error("ERROR /compare:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => console.log(`Grocery price server running on port ${PORT}`));