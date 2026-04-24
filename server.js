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

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 KHTML, like Gecko Chrome/124.0.0.0 Safari/537.36";

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
// ─────────────────────────────────────────────────────────────────────────────
async function searchSainsburys(query) {
  // Try their internal API first
  const apiUrl =
    `https://www.sainsburys.co.uk/gol-ui/api/products` +
    `?filter%5Bkeyword%5D=${encodeURIComponent(query)}&page_number=1&page_size=10&sortBy=RELEVANCE`;

  try {
    const res = await safeFetch(apiUrl, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/json",
        "Accept-Language": "en-GB,en;q=0.9",
        Referer: "https://www.sainsburys.co.uk/",
        "X-Requested-With": "XMLHttpRequest",
      },
    });

    if (res.ok) {
      const json = await res.json();
      const products =
        json?.products ??
        json?.data?.products ??
        json?.catalogue_products ??
        [];

      const mapped = products
        .map((p) => {
          const price =
            p?.retail_price?.price ??
            p?.price ??
            p?.pricing?.nowPrice ??
            p?.unitPrice;
          const unit = p?.unit_price?.measure
            ? `${formatPrice(p.unit_price.price)}/${p.unit_price.measure}`
            : "";
          return {
            name: p.name || p.full_name || query,
            store: "Sainsbury's",
            price: formatPrice(price),
            unit,
          };
        })
        .filter((r) => r.price != null);

      if (mapped.length) {
        console.log(`  Sainsbury's API: ${mapped.length}`);
        return mapped;
      }
    } else {
      console.log(`  Sainsbury's API HTTP ${res.status}`);
    }
  } catch (err) {
    console.log(`  Sainsbury's API error: ${err.message}`);
  }

  // Fallback: scrape the search page __NEXT_DATA__
  return searchSainsburysScrape(query);
}

async function searchSainsburysScrape(query) {
  try {
    const res = await safeFetch(
      `https://www.sainsburys.co.uk/gol-ui/SearchResults/${encodeURIComponent(query)}`,
      {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-GB,en;q=0.9",
        },
      }
    );
    const html = await res.text();
    console.log(`  Sainsbury's scrape HTML length: ${html.length}`);

    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return [];

    const data = JSON.parse(m[1]);
    const results = [];

    const walk = (obj, depth = 0) => {
      if (!obj || typeof obj !== "object" || depth > 15) return;
      if (Array.isArray(obj)) {
        for (const item of obj) {
          if (item?.name && item?.retail_price?.price != null) {
            results.push({
              name: item.name,
              store: "Sainsbury's",
              price: formatPrice(item.retail_price.price),
              unit: item.unit_price?.measure
                ? `${formatPrice(item.unit_price.price)}/${item.unit_price.measure}`
                : "",
            });
          } else {
            walk(item, depth + 1);
          }
        }
      } else {
        for (const val of Object.values(obj)) walk(val, depth + 1);
      }
    };
    walk(data);
    console.log(`  Sainsbury's scrape: ${results.length}`);
    return results.filter((r) => r.price != null);
  } catch (err) {
    console.log(`  Sainsbury's scrape error: ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TESCO — their public product search API
// ─────────────────────────────────────────────────────────────────────────────
async function searchTesco(query) {
  try {
    const url = `https://www.tesco.com/groceries/en-GB/search?query=${encodeURIComponent(query)}&count=10`;
    const res = await safeFetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en;q=0.9",
      },
    });
    const html = await res.text();

    // Tesco embeds product data in __NEXT_DATA__
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) {
      console.log("  Tesco: no __NEXT_DATA__");
      return [];
    }

    const data = JSON.parse(m[1]);
    const results = [];

    const walk = (obj, depth = 0) => {
      if (!obj || typeof obj !== "object" || depth > 15) return;
      if (Array.isArray(obj)) {
        for (const item of obj) {
          // Tesco product shape: { title, price: { actual, unitPrice } }
          if (item?.title && item?.price?.actual != null) {
            results.push({
              name: item.title,
              store: "Tesco",
              price: formatPrice(item.price.actual),
              unit: item.price.unitPrice
                ? `${formatPrice(item.price.unitPrice)}/${item.price.unitOfMeasure || "unit"}`
                : "",
            });
          } else {
            walk(item, depth + 1);
          }
        }
      } else {
        for (const val of Object.values(obj)) walk(val, depth + 1);
      }
    };
    walk(data);
    console.log(`  Tesco: ${results.length}`);
    return results.filter((r) => r.price != null);
  } catch (err) {
    console.log(`  Tesco error: ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TROLLEY.CO.UK via Playwright
// Playwright installs its own Chromium with all needed system libs.
// ─────────────────────────────────────────────────────────────────────────────
let playwrightBrowser = null;

async function getBrowser() {
  if (playwrightBrowser) return playwrightBrowser;
  const { chromium } = require("playwright");
  playwrightBrowser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
  console.log("  Playwright browser launched");
  return playwrightBrowser;
}

async function searchTrolley(query) {
  let browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    console.log(`  Playwright unavailable: ${err.message}`);
    return [];
  }

  let page;
  try {
    const context = await browser.newContext({
      userAgent: BROWSER_UA,
      extraHTTPHeaders: { "Accept-Language": "en-GB,en;q=0.9" },
    });

    page = await context.newPage();

    // Block images/fonts/css to speed up
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "font", "stylesheet", "media"].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    await page.goto(
      `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`,
      { waitUntil: "networkidle", timeout: 30000 }
    );

    // Wait for price elements
    await page.waitForSelector('[class*="price"], [data-price]', { timeout: 8000 }).catch(() => {});

    const results = await page.evaluate((q) => {
      const items = [];
      const nextEl = document.getElementById("__NEXT_DATA__");
      if (nextEl) {
        try {
          const walk = (obj, depth = 0) => {
            if (!obj || typeof obj !== "object" || depth > 12) return;
            if (Array.isArray(obj)) {
              for (const item of obj) {
                if (item?.name && (item?.supermarkets || item?.prices || item?.lowestPrice != null)) {
                  const name = item.name || q;
                  if (Array.isArray(item.supermarkets)) {
                    for (const s of item.supermarkets) {
                      if (s.price != null && s.name)
                        items.push({ name, store: s.name, price: s.price, unit: s.unitPrice || "" });
                    }
                  }
                  if (item.prices && typeof item.prices === "object") {
                    for (const [store, price] of Object.entries(item.prices)) {
                      if (price != null) items.push({ name, store, price, unit: "" });
                    }
                  }
                } else {
                  walk(item, depth + 1);
                }
              }
            } else {
              for (const val of Object.values(obj)) walk(val, depth + 1);
            }
          };
          walk(JSON.parse(nextEl.textContent));
        } catch (_) {}
      }
      // DOM fallback
      if (!items.length) {
        document.querySelectorAll('[class*="ProductCard"], [class*="product-card"]').forEach((card) => {
          const name = card.querySelector('[class*="title"], [class*="name"], h2, h3')?.textContent?.trim();
          const priceText = card.querySelector('[class*="price"]')?.textContent?.trim();
          const store = card.querySelector("img[alt]")?.alt?.trim();
          if (name && priceText) items.push({ name, store: store || "Trolley", price: priceText, unit: "" });
        });
      }
      return items;
    }, query);

    await context.close();

    const formatted = results
      .map((r) => ({ name: r.name, store: r.store, price: formatPrice(r.price), unit: r.unit || "" }))
      .filter((r) => r.price != null);

    console.log(`  Trolley: ${formatted.length}`);
    return formatted;
  } catch (err) {
    console.error(`  Trolley error: ${err.message}`);
    if (page) await page.close().catch(() => {});
    // Reset browser on error so next call gets a fresh one
    playwrightBrowser = null;
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AGGREGATE — all three in parallel
// ─────────────────────────────────────────────────────────────────────────────
async function searchAll(query) {
  console.log(`\nSearching: "${query}"`);
  const [s, t, tc] = await Promise.allSettled([
    searchSainsburys(query),
    searchTesco(query),
    searchTrolley(query),
  ]);
  const sainsburys = s.status === "fulfilled" ? s.value : [];
  const tesco      = t.status === "fulfilled" ? t.value : [];
  const trolley    = tc.status === "fulfilled" ? tc.value : [];
  console.log(
    `  Results — Sainsbury's: ${sainsburys.length} | Tesco: ${tesco.length} | Trolley: ${trolley.length}`
  );
  return [...sainsburys, ...tesco, ...trolley];
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

// Graceful shutdown
process.on("SIGTERM", async () => {
  if (playwrightBrowser) await playwrightBrowser.close().catch(() => {});
  process.exit(0);
});

app.listen(PORT, () => console.log(`Grocery price server running on port ${PORT}`));