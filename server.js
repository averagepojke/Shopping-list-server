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
// SAINSBURY'S — their gol-ui JSON API
// ─────────────────────────────────────────────────────────────────────────────
async function searchSainsburys(query) {
  const url =
    `https://www.sainsburys.co.uk/gol-ui/api/products` +
    `?filter%5Bkeyword%5D=${encodeURIComponent(query)}&page_number=1&page_size=10&sortBy=RELEVANCE`;

  const res = await safeFetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "application/json",
      "Accept-Language": "en-GB,en;q=0.9",
      Referer: "https://www.sainsburys.co.uk/",
    },
  });

  if (!res.ok) {
    console.log(`  Sainsbury's HTTP ${res.status}`);
    return [];
  }

  const json = await res.json();
  const products = json?.products ?? json?.data?.products ?? [];

  return products
    .map((p) => {
      const price =
        p?.retail_price?.price ?? p?.price ?? p?.unitPrice ?? p?.pricing?.nowPrice;
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
}

// ─────────────────────────────────────────────────────────────────────────────
// ASDA — try multiple endpoints they've used
// ─────────────────────────────────────────────────────────────────────────────
async function searchAsda(query) {
  // Endpoint 1: their storefront search API (used by the website)
  const endpoints = [
    {
      url: `https://groceries.asda.com/api/bgeography/search?q=${encodeURIComponent(query)}&page=1&pageSize=10&cacheable=true`,
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/json",
        "Accept-Language": "en-GB,en;q=0.9",
        Referer: "https://www.asda.com/",
        Origin: "https://www.asda.com",
        "request-origin": "gi",
        store: "4565",
      },
    },
    {
      url: `https://groceries.asda.com/api/v3/items?q=${encodeURIComponent(query)}&store_id=4565&page_num=1&page_size=10&request_origin=gi`,
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/json",
        "Accept-Language": "en-GB,en;q=0.9",
        Referer: "https://www.asda.com/",
        Origin: "https://www.asda.com",
      },
    },
  ];

  for (const ep of endpoints) {
    try {
      const res = await safeFetch(ep.url, { headers: ep.headers });
      if (!res.ok) {
        console.log(`  ASDA endpoint failed: HTTP ${res.status} — ${ep.url.split("?")[0]}`);
        continue;
      }
      const json = await res.json();
      const products =
        json?.data?.itemsAndRecommendations?.[0]?.items?.items ??
        json?.items?.items ??
        json?.searchResults?.resultList?.resultListItems ??
        json?.results ??
        [];

      const mapped = products
        .map((p) => {
          const price =
            p?.price?.price ??
            p?.retailPrice ??
            p?.salePrice ??
            p?.listPrice ??
            p?.item?.price?.price;
          const unit = p?.price?.unitPrice
            ? `${formatPrice(p.price.unitPrice)}/${p.price.unitOfMeasure || "unit"}`
            : "";
          return {
            name: p.name || p.item?.name || query,
            store: "Asda",
            price: formatPrice(price),
            unit,
          };
        })
        .filter((r) => r.price != null);

      if (mapped.length) return mapped;
    } catch (err) {
      console.log(`  ASDA endpoint error: ${err.message}`);
    }
  }

  // Last resort: scrape the ASDA search page HTML for JSON-LD prices
  return searchAsdaScrape(query);
}

async function searchAsdaScrape(query) {
  try {
    const res = await safeFetch(
      `https://www.asda.com/groceries/search/${encodeURIComponent(query)}`,
      {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-GB,en;q=0.9",
        },
      }
    );
    const html = await res.text();

    // Pull prices from __NEXT_DATA__
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return [];
    const data = JSON.parse(m[1]);

    const results = [];
    const walk = (obj, depth = 0) => {
      if (!obj || typeof obj !== "object" || depth > 12) return;
      if (Array.isArray(obj)) {
        for (const item of obj) {
          if (item?.name && (item?.price != null || item?.retailPrice != null)) {
            const price = item.price ?? item.retailPrice ?? item.salePrice;
            results.push({
              name: item.name,
              store: "Asda",
              price: formatPrice(price),
              unit: "",
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
    console.log(`  ASDA scrape: ${results.length} results`);
    return results.filter((r) => r.price != null);
  } catch (err) {
    console.log(`  ASDA scrape error: ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TROLLEY.CO.UK via Puppeteer
// Uses @sparticuz/chromium which bundles its own Chromium binary — no system
// Chrome install needed, works on Railway/Render/Docker out of the box.
// ─────────────────────────────────────────────────────────────────────────────
async function searchTrolley(query) {
  let puppeteer, chromium;

  try {
    chromium = require("@sparticuz/chromium");
    puppeteer = require("puppeteer-core");
  } catch (_) {
    try {
      puppeteer = require("puppeteer");
      chromium = null;
    } catch (_2) {
      console.log("  ⚠️  puppeteer not installed — skipping Trolley");
      return [];
    }
  }

  let browser;
  try {
    // @sparticuz/chromium provides everything needed — no system deps required
    const execPath = chromium
      ? await chromium.executablePath()
      : undefined;

    const launchArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",   // use /tmp instead of /dev/shm (fixes Railway)
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process",          // important for constrained environments
      "--disable-extensions",
    ];

    browser = await puppeteer.launch({
      args: chromium ? [...chromium.args, ...launchArgs] : launchArgs,
      defaultViewport: chromium?.defaultViewport ?? { width: 1280, height: 800 },
      executablePath: execPath,
      headless: chromium ? chromium.headless : "new",
    });

    const page = await browser.newPage();
    await page.setUserAgent(BROWSER_UA);
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-GB,en;q=0.9" });

    // Block heavy resources to speed things up
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (["image", "font", "stylesheet", "media"].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(
      `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`,
      { waitUntil: "networkidle2", timeout: 30000 }
    );

    // Wait for any price element
    await page
      .waitForSelector('[class*="price"], [data-price]', { timeout: 8000 })
      .catch(() => {});

    const results = await page.evaluate((q) => {
      const items = [];

      // __NEXT_DATA__ — fastest path
      const nextEl = document.getElementById("__NEXT_DATA__");
      if (nextEl) {
        try {
          const walk = (obj, depth = 0) => {
            if (!obj || typeof obj !== "object" || depth > 12) return;
            if (Array.isArray(obj)) {
              for (const item of obj) {
                if (
                  item &&
                  item.name &&
                  (item.supermarkets || item.prices || item.lowestPrice != null)
                ) {
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
        document
          .querySelectorAll('[class*="product"], [data-testid*="product"]')
          .forEach((card) => {
            const name = card.querySelector('[class*="name"], h2, h3')?.textContent?.trim();
            const price = card.querySelector('[class*="price"]')?.textContent?.trim();
            const store = card.querySelector("img[alt]")?.alt?.trim();
            if (name && price) items.push({ name, store: store || "Trolley", price, unit: "" });
          });
      }

      return items;
    }, query);

    const formatted = results
      .map((r) => ({ name: r.name, store: r.store, price: formatPrice(r.price), unit: r.unit || "" }))
      .filter((r) => r.price != null);

    console.log(`  Trolley: ${formatted.length} results`);
    return formatted;
  } catch (err) {
    console.error("  Trolley error:", err.message);
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AGGREGATE
// ─────────────────────────────────────────────────────────────────────────────
async function searchAll(query) {
  console.log(`\nSearching: "${query}"`);
  const [s, a, t] = await Promise.allSettled([
    searchSainsburys(query),
    searchAsda(query),
    searchTrolley(query),
  ]);
  const sainsburys = s.status === "fulfilled" ? s.value : [];
  const asda       = a.status === "fulfilled" ? a.value : [];
  const trolley    = t.status === "fulfilled" ? t.value : [];
  console.log(`  Sainsbury's: ${sainsburys.length} | ASDA: ${asda.length} | Trolley: ${trolley.length}`);
  return [...sainsburys, ...asda, ...trolley];
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

app.listen(PORT, () => console.log(`Grocery price server running on port ${PORT}`));