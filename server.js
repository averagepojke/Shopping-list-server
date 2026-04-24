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
  return best ? { store: best.store, price: best.price, name: best.name, unit: best.unit || "" } : null;
}

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 KHTML, like Gecko Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-GB,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
};

async function safeFetch(url, opts = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SAINSBURY'S
// API used by their own website — returns JSON directly, no auth needed.
// ─────────────────────────────────────────────────────────────────────────────
async function searchSainsburys(query) {
  const url = `https://www.sainsburys.co.uk/gol-ui/api/products?filter%5Bkeyword%5D=${encodeURIComponent(query)}&page_number=1&page_size=10&sortBy=RELEVANCE`;

  const res = await safeFetch(url, {
    headers: {
      ...BROWSER_HEADERS,
      Accept: "application/json",
      Referer: "https://www.sainsburys.co.uk/",
    },
  });

  if (!res.ok) {
    console.log(`  Sainsbury's HTTP ${res.status}`);
    return [];
  }

  const json = await res.json();
  const products = json?.products ?? json?.data?.products ?? [];

  return products.map((p) => {
    const price = p?.retail_price?.price ?? p?.price ?? p?.unitPrice;
    const unit  = p?.unit_price?.measure ? `${formatPrice(p.unit_price.price)}/${p.unit_price.measure}` : "";
    return {
      name:  p.name || p.full_name || query,
      store: "Sainsbury's",
      price: formatPrice(price),
      unit,
    };
  }).filter(r => r.price != null);
}

// ─────────────────────────────────────────────────────────────────────────────
// ASDA
// ASDA's storefront uses a GraphQL endpoint. We POST the query they use.
// ─────────────────────────────────────────────────────────────────────────────
async function searchAsda(query) {
  const url = "https://groceries.asda.com/api/bgeography/search";

  // ASDA also exposes a simpler REST endpoint used by their mobile app
  const restUrl = `https://groceries.asda.com/api/v3/items?q=${encodeURIComponent(query)}&store_id=4565&page_num=1&page_size=10&request_origin=gi`;

  let res = await safeFetch(restUrl, {
    headers: {
      ...BROWSER_HEADERS,
      Accept: "application/json",
      Referer: "https://www.asda.com/",
      Origin: "https://www.asda.com",
    },
  });

  // Fallback to their search API if the v3 endpoint fails
  if (!res.ok) {
    console.log(`  ASDA v3 HTTP ${res.status}, trying fallback`);
    const fallback = `https://groceries.asda.com/api/bgeography/search?q=${encodeURIComponent(query)}&page=1&pageSize=10`;
    res = await safeFetch(fallback, {
      headers: {
        ...BROWSER_HEADERS,
        Accept: "application/json",
        Referer: "https://www.asda.com/",
      },
    });
  }

  if (!res.ok) {
    console.log(`  ASDA HTTP ${res.status}`);
    return [];
  }

  const json = await res.json();

  // Try multiple response shapes ASDA has used over time
  const products =
    json?.data?.itemsAndRecommendations?.[0]?.items?.items ??
    json?.items?.items ??
    json?.results ??
    json?.data?.items ??
    [];

  return products.map((p) => {
    const price = p?.price?.price ?? p?.retailPrice ?? p?.salePrice;
    const unit  = p?.price?.unitPrice ? `${formatPrice(p.price.unitPrice)}/${p.price.unitOfMeasure || "unit"}` : "";
    return {
      name:  p.name || p.item?.name || query,
      store: "Asda",
      price: formatPrice(price),
      unit,
    };
  }).filter(r => r.price != null);
}

// ─────────────────────────────────────────────────────────────────────────────
// TROLLEY.CO.UK via Puppeteer
// Trolley loads prices client-side so we need a real browser.
// We use puppeteer-core + @sparticuz/chromium for serverless/Docker deploys.
// Falls back gracefully if puppeteer isn't installed.
// ─────────────────────────────────────────────────────────────────────────────
async function searchTrolley(query) {
  let puppeteer, chromium;

  try {
    // Try the serverless-friendly combo first (@sparticuz/chromium)
    chromium = require("@sparticuz/chromium");
    puppeteer = require("puppeteer-core");
  } catch (_) {
    try {
      // Fall back to full puppeteer (local dev)
      puppeteer = require("puppeteer");
      chromium = null;
    } catch (_2) {
      console.log("  ⚠️  puppeteer not installed — skipping Trolley");
      return [];
    }
  }

  let browser;
  try {
    const launchOpts = chromium
      ? {
          args: chromium.args,
          defaultViewport: chromium.defaultViewport,
          executablePath: await chromium.executablePath(),
          headless: chromium.headless,
        }
      : {
          headless: "new",
          args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        };

    browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();

    await page.setUserAgent(BROWSER_HEADERS["User-Agent"]);
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-GB,en;q=0.9" });

    // Block images/fonts/css to speed up load
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "font", "stylesheet", "media"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    const searchUrl = `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for price elements to appear
    await page.waitForSelector('[class*="price"], [data-price], .product-price', { timeout: 10000 }).catch(() => {});

    // Extract product + price data from the rendered DOM
    const results = await page.evaluate((q) => {
      const items = [];

      // Try __NEXT_DATA__ first (fastest)
      const nextEl = document.getElementById("__NEXT_DATA__");
      if (nextEl) {
        try {
          const data = JSON.parse(nextEl.textContent);
          // Walk the props tree for product arrays
          const walk = (obj, depth = 0) => {
            if (!obj || typeof obj !== "object" || depth > 12) return;
            if (Array.isArray(obj)) {
              for (const item of obj) {
                if (item && item.name && (item.supermarkets || item.prices || item.lowestPrice != null)) {
                  const name = item.name || q;
                  if (Array.isArray(item.supermarkets)) {
                    for (const s of item.supermarkets) {
                      if (s.price != null && s.name) {
                        items.push({ name, store: s.name, price: s.price, unit: s.unitPrice || "" });
                      }
                    }
                  }
                  if (item.prices && typeof item.prices === "object") {
                    for (const [store, price] of Object.entries(item.prices)) {
                      if (price != null) items.push({ name, store, price, unit: "" });
                    }
                  }
                  if (!items.length && item.lowestPrice != null) {
                    items.push({ name, store: item.cheapestSupermarket || "Unknown", price: item.lowestPrice, unit: "" });
                  }
                } else {
                  walk(item, depth + 1);
                }
              }
            } else {
              for (const val of Object.values(obj)) walk(val, depth + 1);
            }
          };
          walk(data);
        } catch (_) {}
      }

      // DOM fallback — scrape visible price elements
      if (!items.length) {
        const cards = document.querySelectorAll('[class*="product-card"], [class*="ProductCard"], [data-testid*="product"]');
        cards.forEach((card) => {
          const nameEl = card.querySelector('[class*="name"], [class*="title"], h2, h3');
          const priceEl = card.querySelector('[class*="price"], [data-price]');
          const storeEl = card.querySelector('[class*="store"], [class*="supermarket"], img[alt]');
          if (nameEl && priceEl) {
            items.push({
              name:  nameEl.textContent.trim(),
              store: storeEl?.alt || storeEl?.textContent?.trim() || "Trolley",
              price: priceEl.textContent.trim().replace(/[^£\d.]/g, ""),
              unit:  "",
            });
          }
        });
      }

      return items;
    }, query);

    const formatted = results.map((r) => ({
      name:  r.name,
      store: r.store,
      price: formatPrice(r.price),
      unit:  r.unit || "",
    })).filter((r) => r.price != null);

    console.log(`  Trolley puppeteer: ${formatted.length} results`);
    return formatted;

  } catch (err) {
    console.error("  Trolley puppeteer error:", err.message);
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AGGREGATE: run all three in parallel, merge + dedupe
// ─────────────────────────────────────────────────────────────────────────────
async function searchAll(query) {
  console.log(`\nSearching all stores for: "${query}"`);

  const [sainsburys, asda, trolley] = await Promise.allSettled([
    searchSainsburys(query),
    searchAsda(query),
    searchTrolley(query),
  ]);

  const s = sainsburys.status === "fulfilled" ? sainsburys.value : [];
  const a = asda.status      === "fulfilled" ? asda.value      : [];
  const t = trolley.status   === "fulfilled" ? trolley.value   : [];

  console.log(`  Sainsbury's: ${s.length} | ASDA: ${a.length} | Trolley: ${t.length}`);

  return [...s, ...a, ...t];
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get("/", (_, res) => {
  res.send("Grocery price API. GET /search?q=milk  |  POST /compare { items: ['milk','bread'] }");
});

// GET /search?q=milk
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

// POST /compare { items: ["milk", "bread"] }  or  { q: "milk" }
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

app.listen(PORT, () => console.log(`Grocery price server running on port ${PORT}`));