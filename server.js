const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function toNumber(p) {
  const n = parseFloat(String(p).replace(/[^\d.]/g, ""));
  return isNaN(n) ? null : n;
}
function formatPrice(p) {
  const n = toNumber(p);
  return n == null ? null : `£${n.toFixed(2)}`;
}
function findCheapest(results) {
  let best = null;
  for (const r of results) {
    const n = toNumber(r.price);
    if (n == null) continue;
    if (!best || n < toNumber(best.price)) best = r;
  }
  return best
    ? { store: best.store, price: best.price, name: best.name, unit: best.unit || "" }
    : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// BROWSER — single shared Playwright instance
// ─────────────────────────────────────────────────────────────────────────────
let _browser = null;

async function getBrowser() {
  if (_browser) return _browser;
  const { chromium } = require("playwright");
  _browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  console.log("Playwright browser ready");
  return _browser;
}

async function newPage() {
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 KHTML, like Gecko Chrome/124.0.0.0 Safari/537.36",
    locale: "en-GB",
    extraHTTPHeaders: { "Accept-Language": "en-GB,en;q=0.9" },
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();

  // Block images/fonts/media to speed up page loads
  await page.route("**/*", (route) => {
    if (["image", "font", "media", "stylesheet"].includes(route.request().resourceType())) {
      route.abort();
    } else {
      route.continue();
    }
  });

  return { page, ctx };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACT PRICES from __NEXT_DATA__ — shared by Tesco, Sainsbury's, Trolley
// ─────────────────────────────────────────────────────────────────────────────
function extractNextData(json, storeName) {
  const results = [];

  const walk = (obj, depth = 0) => {
    if (!obj || typeof obj !== "object" || depth > 15) return;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (item && typeof item === "object") {
          // Sainsbury's shape
          if (item.retail_price?.price != null && item.name) {
            results.push({
              name: item.name,
              store: storeName || "Sainsbury's",
              price: formatPrice(item.retail_price.price),
              unit: item.unit_price?.measure
                ? `${formatPrice(item.unit_price.price)}/${item.unit_price.measure}`
                : "",
            });
          }
          // Tesco shape
          else if (item.price?.actual != null && (item.title || item.name)) {
            results.push({
              name: item.title || item.name,
              store: storeName || "Tesco",
              price: formatPrice(item.price.actual),
              unit: item.price.unitPrice
                ? `${formatPrice(item.price.unitPrice)}/${item.price.unitOfMeasure || "unit"}`
                : "",
            });
          }
          // Trolley shape — item has supermarkets array
          else if (item.name && Array.isArray(item.supermarkets)) {
            for (const s of item.supermarkets) {
              if (s.price != null && s.name) {
                results.push({
                  name: item.name,
                  store: s.name,
                  price: formatPrice(s.price),
                  unit: s.unitPrice ? formatPrice(s.unitPrice) : "",
                });
              }
            }
          }
          // Trolley shape — item has prices object
          else if (item.name && item.prices && typeof item.prices === "object") {
            for (const [store, price] of Object.entries(item.prices)) {
              if (price != null) {
                results.push({
                  name: item.name,
                  store,
                  price: formatPrice(price),
                  unit: "",
                });
              }
            }
          }
          else {
            walk(item, depth + 1);
          }
        }
      }
    } else {
      for (const val of Object.values(obj)) walk(val, depth + 1);
    }
  };

  walk(json);
  return results.filter((r) => r.price != null);
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERCEPT API RESPONSES — catches XHR/fetch calls the page makes
// This is the most reliable approach: let the real browser make the real
// requests, intercept the JSON responses as they arrive.
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeWithIntercept(url, store, apiPatterns, waitSelector, timeout = 25000) {
  const { page, ctx } = await newPage();
  const intercepted = [];

  try {
    // Intercept API responses matching our patterns
    page.on("response", async (response) => {
      const respUrl = response.url();
      if (apiPatterns.some((p) => respUrl.includes(p))) {
        try {
          const json = await response.json();
          intercepted.push(json);
          console.log(`  [intercept] ${store}: got response from ${respUrl.split("?")[0]}`);
        } catch (_) {}
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout });

    // Wait for a product/price element to appear
    if (waitSelector) {
      await page.waitForSelector(waitSelector, { timeout: 12000 }).catch(() => {});
    } else {
      await page.waitForTimeout(4000);
    }

    // Also try __NEXT_DATA__
    const nextDataText = await page
      .evaluate(() => document.getElementById("__NEXT_DATA__")?.textContent)
      .catch(() => null);

    let results = [];

    // Parse intercepted API responses first
    for (const json of intercepted) {
      const r = parseStoreJson(json, store);
      results.push(...r);
    }

    // Fall back to __NEXT_DATA__
    if (!results.length && nextDataText) {
      try {
        const nd = JSON.parse(nextDataText);
        results = extractNextData(nd, store);
        console.log(`  [nextdata] ${store}: ${results.length}`);
      } catch (_) {}
    }

    // Last resort: scrape visible price text from DOM
    if (!results.length) {
      results = await scrapePricesFromDom(page, store);
      console.log(`  [dom] ${store}: ${results.length}`);
    }

    return results;
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSE STORE-SPECIFIC JSON RESPONSES
// ─────────────────────────────────────────────────────────────────────────────
function parseStoreJson(json, store) {
  const results = [];

  // Sainsbury's API response shape
  const sProducts =
    json?.products ??
    json?.data?.products ??
    json?.catalogue_products ??
    [];
  if (sProducts.length) {
    for (const p of sProducts) {
      const price = p?.retail_price?.price ?? p?.price ?? p?.pricing?.nowPrice;
      if (price == null || !p.name) continue;
      results.push({
        name: p.name,
        store: "Sainsbury's",
        price: formatPrice(price),
        unit: p.unit_price?.measure
          ? `${formatPrice(p.unit_price.price)}/${p.unit_price.measure}`
          : "",
      });
    }
    return results;
  }

  // Tesco API response shape
  const tProducts =
    json?.elements ??
    json?.data?.results?.productItems ??
    json?.productItems ??
    [];
  if (tProducts.length) {
    for (const p of tProducts) {
      const item = p.product || p;
      const price = item?.price ?? item?.unitPrice;
      if (price == null || !item.title) continue;
      results.push({
        name: item.title || item.name,
        store: "Tesco",
        price: formatPrice(price),
        unit: item.unitPrice ? `${formatPrice(item.unitPrice)}/${item.unitOfMeasure || "unit"}` : "",
      });
    }
    return results;
  }

  // Trolley API
  const tItems =
    json?.products ??
    json?.results ??
    [];
  if (tItems.length) {
    return extractNextData({ items: tItems }, store);
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM SCRAPE FALLBACK — reads visible price text from rendered page
// ─────────────────────────────────────────────────────────────────────────────
async function scrapePricesFromDom(page, store) {
  return page.evaluate((storeName) => {
    const items = [];
    const cards = document.querySelectorAll(
      '[class*="product"], [class*="Product"], [data-testid*="product"], article'
    );
    cards.forEach((card) => {
      const nameEl =
        card.querySelector('[class*="title"], [class*="name"], [class*="Title"], h2, h3, h4');
      const priceEl =
        card.querySelector('[class*="price"], [class*="Price"], [data-price]');
      if (!nameEl || !priceEl) return;
      const priceText = priceEl.textContent.trim();
      const hasPrice = /£[\d.]+/.test(priceText);
      if (!hasPrice) return;
      items.push({
        name: nameEl.textContent.trim().slice(0, 120),
        store: storeName,
        price: priceText.match(/£[\d.]+/)?.[0] ?? priceText,
        unit: "",
      });
    });
    return items;
  }, store);
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-STORE SEARCH FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────
async function searchSainsburys(query) {
  try {
    const results = await scrapeWithIntercept(
      `https://www.sainsburys.co.uk/gol-ui/SearchResults/${encodeURIComponent(query)}`,
      "Sainsbury's",
      ["gol-ui/api/products", "api/products"],
      '[class*="product-list"], [class*="ProductList"]'
    );
    console.log(`  Sainsbury's total: ${results.length}`);
    return results;
  } catch (err) {
    console.log(`  Sainsbury's error: ${err.message}`);
    return [];
  }
}

async function searchTesco(query) {
  try {
    const results = await scrapeWithIntercept(
      `https://www.tesco.com/groceries/en-GB/search?query=${encodeURIComponent(query)}&count=10`,
      "Tesco",
      ["api/product/search", "groceries/api", "search?query="],
      '[class*="product-list"], .product-list'
    );
    console.log(`  Tesco total: ${results.length}`);
    return results;
  } catch (err) {
    console.log(`  Tesco error: ${err.message}`);
    return [];
  }
}

async function searchTrolley(query) {
  try {
    const results = await scrapeWithIntercept(
      `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`,
      "Trolley",
      ["trolley.co.uk/api", "trueview", "_data", "products.json"],
      '[class*="price"], [class*="product-card"]'
    );
    console.log(`  Trolley total: ${results.length}`);
    return results;
  } catch (err) {
    console.log(`  Trolley error: ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AGGREGATE
// ─────────────────────────────────────────────────────────────────────────────
async function searchAll(query) {
  console.log(`\nSearching: "${query}"`);
  const [s, t, tr] = await Promise.allSettled([
    searchSainsburys(query),
    searchTesco(query),
    searchTrolley(query),
  ]);
  const sainsburys = s.status  === "fulfilled" ? s.value  : [];
  const tesco      = t.status  === "fulfilled" ? t.value  : [];
  const trolley    = tr.status === "fulfilled" ? tr.value : [];
  const all = [...sainsburys, ...tesco, ...trolley];
  console.log(
    `  Final — Sainsbury's: ${sainsburys.length} | Tesco: ${tesco.length} | Trolley: ${trolley.length}`
  );
  return all;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get("/", (_, res) => {
  res.send("Grocery price API — GET /search?q=milk  |  POST /compare { items: ['milk','bread'] }");
});

app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing ?q= param" });
  try {
    const results = await searchAll(query);
    res.json({ query, results });
  } catch (err) {
    console.error("ERROR /search:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/compare", async (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : body.q ? [body.q] : [];
  if (!items.length)
    return res.status(400).json({ error: 'Send { "items": ["milk","bread"] } or { "q": "milk" }' });
  try {
    const itemResults = await Promise.all(
      items.map(async (q) => {
        try {
          const results = await searchAll(q);
          return { query: q, results, cheapest: findCheapest(results) };
        } catch (err) {
          return { query: q, results: [], cheapest: null, error: err.message };
        }
      })
    );
    res.json({ items: itemResults });
  } catch (err) {
    console.error("ERROR /compare:", err.message);
    res.status(500).json({ error: err.message });
  }
});

process.on("SIGTERM", async () => {
  if (_browser) await _browser.close().catch(() => {});
  process.exit(0);
});

app.listen(PORT, () => console.log(`Grocery price server running on port ${PORT}`));