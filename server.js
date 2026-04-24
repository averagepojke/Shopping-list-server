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

  // Block images/fonts/media/stylesheets to speed up page loads
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
          } else {
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
// PARSE STORE-SPECIFIC JSON RESPONSES (from intercepted XHR/fetch calls)
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
    if (results.length) return results;
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
        unit: item.unitPrice
          ? `${formatPrice(item.unitPrice)}/${item.unitOfMeasure || "unit"}`
          : "",
      });
    }
    if (results.length) return results;
  }

  // Trolley API fallback
  const tItems = json?.products ?? json?.results ?? [];
  if (tItems.length) {
    return extractNextData({ items: tItems }, store);
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM SCRAPE — reads rendered prices from the page
// Trolley-aware: handles per-store price cards and text-node fallback
// ─────────────────────────────────────────────────────────────────────────────
async function scrapePricesFromDom(page, store) {
  return page.evaluate((storeName) => {
    const items = [];
    const priceRegex = /£([\d]+\.[\d]{2})/;

    // ── Trolley-specific: parse .product-item cards line by line ────────────
    // Each card's innerText looks like:
    //   "320g\nSainsbury's\nBritish Fresh Chicken Thigh Fillets\n368\n£3.75\n£1.17 per 100g"
    // Store names Trolley uses (for detection):
    if (storeName === "Trolley") {
      const KNOWN_STORES = new Set([
        "Asda","Tesco","Sainsbury's","Morrisons","Co-op","Iceland",
        "Boots","Superdrug","ALDI","Aldi","Waitrose","B&M","Poundland",
        "Savers","Ocado","Amazon","Ebay","M&S","Lidl","Holland & Barrett",
      ]);

      const cards = document.querySelectorAll(".product-item, [class~='product-item']");

      for (const card of cards) {
        const raw = (card.innerText || card.textContent || "").trim();
        if (!raw) continue;

        // Split into non-empty lines
        const lines = raw.split(/\n/).map(l => l.trim()).filter(Boolean);

        // Find the price line — first line matching £X.XX
        const priceLineIdx = lines.findIndex(l => /^£[\d]+\.[\d]{2}$/.test(l));
        if (priceLineIdx === -1) continue;

        const price = lines[priceLineIdx];

        // Unit price — next line after price, e.g. "£1.17 per 100g"
        const unitLine = lines[priceLineIdx + 1] || "";
        const unit = /per/.test(unitLine) ? unitLine : "";

        // Find store — first line that matches a known store name
        let store2 = storeName;
        let storeLineIdx = -1;
        for (let i = 0; i < priceLineIdx; i++) {
          if (KNOWN_STORES.has(lines[i])) {
            store2 = lines[i];
            storeLineIdx = i;
            break;
          }
        }

        // Product name — longest non-numeric line before the price that isn't the store
        let productName = null;
        for (let i = 0; i < priceLineIdx; i++) {
          if (i === storeLineIdx) continue;           // skip store line
          if (/^\d+$/.test(lines[i])) continue;       // skip review counts
          if (/^\d+g$|^\d+ml$|^\d+kg$/.test(lines[i])) continue; // skip size tokens
          if (lines[i].length < 4) continue;
          // Pick the longest candidate as the product name
          if (!productName || lines[i].length > productName.length) {
            productName = lines[i];
          }
        }

        if (!productName) continue;

        items.push({
          name: productName.slice(0, 150),
          store: store2,
          price,
          unit,
        });
      }

      // Deduplicate by name+store+price
      const seen = new Map();
      for (const item of items) {
        const key = `${item.name}|${item.store}|${item.price}`;
        if (!seen.has(key)) seen.set(key, item);
      }
      return [...seen.values()];
    }

    // ── Generic fallback for Tesco / Sainsbury's DOM ──────────────────────────
    const cards = document.querySelectorAll(
      '[class*="product"], [class*="Product"], [data-testid*="product"], article'
    );
    cards.forEach((card) => {
      const nameEl = card.querySelector(
        '[class*="title"], [class*="name"], [class*="Title"], h2, h3, h4'
      );
      const priceEl = card.querySelector(
        '[class*="price"], [class*="Price"], [data-price]'
      );
      if (!nameEl || !priceEl) return;
      const priceText = priceEl.textContent.trim();
      const priceMatch = priceText.match(priceRegex);
      if (!priceMatch) return;
      items.push({
        name: nameEl.textContent.trim().slice(0, 120),
        store: storeName,
        price: `£${priceMatch[1]}`,
        unit: "",
      });
    });
    return items;
  }, store);
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERCEPT API RESPONSES — catches XHR/fetch calls the page makes
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeWithIntercept(url, store, apiPatterns, waitSelector, timeout = 25000) {
  const { page, ctx } = await newPage();
  const intercepted = [];

  try {
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

    if (waitSelector) {
      await page.waitForSelector(waitSelector, { timeout: 12000 }).catch(() => {});
    } else {
      await page.waitForTimeout(4000);
    }

    const nextDataText = await page
      .evaluate(() => document.getElementById("__NEXT_DATA__")?.textContent)
      .catch(() => null);

    let results = [];

    // 1. Intercepted API responses
    for (const json of intercepted) {
      const r = parseStoreJson(json, store);
      results.push(...r);
    }

    // 2. __NEXT_DATA__ fallback
    if (!results.length && nextDataText) {
      try {
        const nd = JSON.parse(nextDataText);
        results = extractNextData(nd, store);
        console.log(`  [nextdata] ${store}: ${results.length}`);
      } catch (_) {}
    }

    // 3. DOM scrape last resort
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
    const { page, ctx } = await newPage();
    try {
      await page.goto(
        `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`,
        { waitUntil: "domcontentloaded", timeout: 25000 }
      );

      // Wait for prices to render — Trolley is JS-heavy, race multiple signals
      await Promise.race([
        page.waitForSelector('[class*="price"]', { timeout: 10000 }),
        page.waitForSelector('[class*="product"]', { timeout: 10000 }),
        page.waitForSelector('[class*="search-result"]', { timeout: 10000 }),
        page.waitForTimeout(8000),
      ]).catch(() => {});

      // Extra settle time for lazy-loaded content
      await page.waitForTimeout(2000);

      // Strategy 1: DOM scrape (primary for Trolley)
      let results = await scrapePricesFromDom(page, "Trolley");

      // Strategy 2: __NEXT_DATA__ if DOM scrape failed
      if (!results.length) {
        const nextDataText = await page
          .evaluate(() => document.getElementById("__NEXT_DATA__")?.textContent)
          .catch(() => null);
        if (nextDataText) {
          try {
            results = extractNextData(JSON.parse(nextDataText), "Trolley");
            console.log(`  [nextdata] Trolley: ${results.length}`);
          } catch (_) {}
        }
      }

      console.log(`  Trolley total: ${results.length}`);
      return results;
    } finally {
      await ctx.close().catch(() => {});
    }
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
  const sainsburys = s.status === "fulfilled" ? s.value : [];
  const tesco      = t.status === "fulfilled" ? t.value : [];
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
  res.send(
    "Grocery price API\n" +
    "  GET  /search?q=milk\n" +
    "  POST /compare  { items: ['milk','bread'] }\n" +
    "  GET  /debug?q=chicken&store=trolley"
  );
});

app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing ?q= param" });
  try {
    const results = await searchAll(query);
    res.json({ query, results, cheapest: findCheapest(results) });
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

// ─────────────────────────────────────────────────────────────────────────────
// DEBUG — dumps rendered HTML class names so you can tune selectors
// GET /debug?q=chicken&store=trolley|tesco|sainsburys
// ─────────────────────────────────────────────────────────────────────────────
app.get("/debug", async (req, res) => {
  const query = req.query.q || "milk";
  const store = (req.query.store || "trolley").toLowerCase();
  const { page, ctx } = await newPage();
  try {
    const urls = {
      trolley:    `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`,
      tesco:      `https://www.tesco.com/groceries/en-GB/search?query=${encodeURIComponent(query)}&count=10`,
      sainsburys: `https://www.sainsburys.co.uk/gol-ui/SearchResults/${encodeURIComponent(query)}`,
    };
    const url = urls[store] || urls.trolley;

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(5000);

    const { relevantClasses, bodyText, interceptedUrls } = await page.evaluate(() => {
      // Collect class names that look price/product related
      const classSet = new Set();
      document.querySelectorAll("*").forEach((el) => {
        el.classList.forEach((c) => {
          if (/price|product|store|retailer|card|listing|result|search|item/i.test(c)) {
            classSet.add(c);
          }
        });
      });

      // Grab visible text (first 2000 chars)
      const bodyText = (document.body.innerText || "").slice(0, 2000);

      return {
        relevantClasses: [...classSet].sort(),
        bodyText,
        interceptedUrls: [],
      };
    });

    // Also grab DOM-scraped results to see what we'd get
    const domResults = await scrapePricesFromDom(page, store === "trolley" ? "Trolley" : store);

    res.json({
      store,
      query,
      url,
      relevantClasses,
      domResultCount: domResults.length,
      domResultsSample: domResults.slice(0, 10),
      bodyTextSample: bodyText,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await ctx.close().catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────────────────────
process.on("SIGTERM", async () => {
  if (_browser) await _browser.close().catch(() => {});
  process.exit(0);
});

app.listen(PORT, () => console.log(`Grocery price server running on port ${PORT}`));