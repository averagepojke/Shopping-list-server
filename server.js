const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());

const BASE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-GB,en;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------
async function safeFetch(url, headers = {}, timeout = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      headers: { ...BASE_HEADERS, ...headers },
      redirect: "follow",
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// STEP 1: Extract product IDs + names from HTML
// ---------------------------------------------------------------------------
function extractProducts(html) {
  const seen = new Set();
  const products = [];

  // Match product cards
  const regex =
    /<a[^>]+href="\/product\/[^/]+\/([A-Z0-9]+)"[^>]*>[\s\S]*?<span>\s*([^<]+?)\s*</g;

  for (const m of html.matchAll(regex)) {
    const id = m[1];
    const name = m[2].trim();

    if (!seen.has(id)) {
      seen.add(id);
      products.push({ id, name });
    }
  }

  // Fallback: data-id
  for (const m of html.matchAll(/data-id="([A-Z0-9]+)"/g)) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      products.push({ id, name: id });
    }
  }

  return products.slice(0, 10);
}

// ---------------------------------------------------------------------------
// STEP 2: Fetch prices from trueview
// ---------------------------------------------------------------------------
async function fetchPrices(products) {
  if (products.length === 0) return [];

  const ids = products.map((p) => p.id);
  const pos = ids.map((_, i) => i + 1);

  const url =
    `https://www.trolley.co.uk/_library/ajax/trueview.php` +
    `?product_id=${ids.join("|")}&p=${pos.join("|")}&sid=`;

  const res = await safeFetch(url, {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    Referer: "https://www.trolley.co.uk/search/",
  });

  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }

  return parsePrices(data, products);
}

// ---------------------------------------------------------------------------
// Parse trueview JSON
// ---------------------------------------------------------------------------
function parsePrices(data, products) {
  const results = [];

  const items = Array.isArray(data)
    ? data.map((v, i) => [products[i]?.id, v])
    : Object.entries(data);

  for (const [id, item] of items) {
    if (!item || typeof item !== "object") continue;

    const product = products.find((p) => p.id === id);
    const name = product?.name || id;

    // Common structure: stores array
    if (Array.isArray(item.stores)) {
      for (const s of item.stores) {
        if (!s.price || !s.store) continue;

        results.push({
          name,
          store: s.store,
          price: formatPrice(s.price),
          unit: s.unit_price || "",
        });
      }
    }

    // Flat keys fallback
    for (const [k, v] of Object.entries(item)) {
      if (k.endsWith("_price") && v) {
        const store = k.replace("_price", "");
        results.push({
          name,
          store,
          price: formatPrice(v),
          unit: item[`${store}_unit`] || "",
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Price formatter
// ---------------------------------------------------------------------------
function formatPrice(p) {
  const num = parseFloat(String(p).replace(/[^\d.]/g, ""));
  if (isNaN(num)) return p;
  return `£${num.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// MAIN ROUTE
// ---------------------------------------------------------------------------
app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing ?q=" });

  try {
    console.log(`Searching: ${query}`);

    // Step 1: fetch HTML
    const url = `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`;
    const r = await safeFetch(url, { Referer: "https://www.trolley.co.uk/" });

    const html = await r.text();

    // Step 2: extract products
    const products = extractProducts(html);

    if (products.length === 0) {
      return res.json({ query, results: [] });
    }

    console.log(`Found IDs: ${products.map((p) => p.id).join(", ")}`);

    // Step 3: fetch prices
    const results = await fetchPrices(products);

    res.json({ query, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
app.listen(3000, () => console.log("Running on port 3000"));