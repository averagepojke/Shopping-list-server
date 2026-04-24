const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

const BASE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-GB,en;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
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
// Extract product IDs
// ---------------------------------------------------------------------------
function extractProducts(html) {
  const seen = new Set();
  const products = [];

  // /product/.../ID
  for (const m of html.matchAll(/\/product\/[^/]+\/([A-Z0-9]{5,})/g)) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      products.push({ id, name: id });
    }
  }

  // data-id fallback
  for (const m of html.matchAll(/data-id="([A-Z0-9]{5,})"/g)) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      products.push({ id, name: id });
    }
  }

  console.log("Extracted IDs:", products.map(p => p.id));

  return products.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Fetch prices from trueview
// ---------------------------------------------------------------------------
async function fetchPrices(products, cookieStr, query) {
  if (!products.length) return [];

  const ids = products.map(p => p.id);
  const pos = ids.map((_, i) => i + 1);

  const url =
    `https://www.trolley.co.uk/_library/ajax/trueview.php` +
    `?product_id=${ids.join("|")}&p=${pos.join("|")}&sid=`;

  console.log("Calling trueview:", url);

  const res = await safeFetch(url, {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    Referer: `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`,
    Cookie: cookieStr,
  });

  const text = await res.text();

  console.log("trueview length:", text.length);
  console.log("trueview preview:", text.slice(0, 200));

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.log("❌ trueview NOT JSON");
    return [];
  }

  return parsePrices(data, products);
}

// ---------------------------------------------------------------------------
// Parse prices
// ---------------------------------------------------------------------------
function parsePrices(data, products) {
  const results = [];

  const items = Array.isArray(data)
    ? data.map((v, i) => [products[i]?.id, v])
    : Object.entries(data);

  for (const [id, item] of items) {
    if (!item || typeof item !== "object") continue;

    const product = products.find(p => p.id === id);
    const name = product?.name || id;

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

    // fallback
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
function formatPrice(p) {
  const num = parseFloat(String(p).replace(/[^\d.]/g, ""));
  if (isNaN(num)) return p;
  return `£${num.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------
app.get("/", (_, res) => {
  res.send("API running. Use /search?q=milk");
});

app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing ?q=" });

  try {
    console.log("\n========================");
    console.log("Searching:", query);

    // STEP 1: Hit homepage to get session cookies
    const home = await safeFetch("https://www.trolley.co.uk/", {
      Referer: "https://www.google.com/",
      "Upgrade-Insecure-Requests": "1",
    });

    const homeCookiesRaw = home.headers.raw()["set-cookie"] || [];
    const cookieStr = homeCookiesRaw
      .map(c => c.split(";")[0])
      .filter(c => !c.includes("deleted"))
      .join("; ");

    console.log("Homepage cookies:", cookieStr || "(none)");

    // STEP 2: Search page WITH cookies
    const searchUrl = `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`;

    const r = await safeFetch(searchUrl, {
      Referer: "https://www.trolley.co.uk/",
      Cookie: cookieStr,
      "Upgrade-Insecure-Requests": "1",
    });

    const html = await r.text();

    console.log("HTML length:", html.length);

    const products = extractProducts(html);

    if (!products.length) {
      console.log("❌ NO PRODUCTS FOUND");
      return res.json({ query, results: [] });
    }

    // STEP 3: trueview using SAME cookies
    const results = await fetchPrices(products, cookieStr, query);

    console.log("Final results:", results.length);

    res.json({ query, results });

  } catch (err) {
    console.error("ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => console.log(`Running on ${PORT}`));