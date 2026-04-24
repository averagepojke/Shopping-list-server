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
// TROLLEY DOM SCRAPER
// Each .product-item innerText looks like:
//   "320g\nSainsbury's\nProduct Name\n368\n£3.75\n£1.17 per 100g"
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeTrolley(page) {
  return page.evaluate(() => {
    const STORE_MAP = {
      "Asda": "Asda", "ASDA": "Asda",
      "Exceptional by ASDA": "Asda", "Exceptional By Asda": "Asda",
      "Tesco": "Tesco", "Tesco Finest": "Tesco", "Tesco Everyday Value": "Tesco",
      "Sainsbury's": "Sainsbury's", "Sainsburys": "Sainsbury's",
      "Sainsbury's Taste the Difference": "Sainsbury's", "Taste the Difference": "Sainsbury's",
      "Morrisons": "Morrisons", "Morrisons Savers": "Morrisons",
      "Co-op": "Co-op", "Coop": "Co-op", "The Co-operative": "Co-op",
      "Iceland": "Iceland", "The Food Warehouse": "Iceland",
      "Boots": "Boots",
      "Superdrug": "Superdrug",
      "ALDI": "Aldi", "Aldi": "Aldi", "Specially Selected": "Aldi",
      "Waitrose": "Waitrose", "Waitrose Ltd": "Waitrose",
      "B&M": "B&M",
      "Poundland": "Poundland",
      "Savers": "Savers",
      "Ocado": "Ocado",
      "Amazon": "Amazon",
      "Ebay": "eBay", "eBay": "eBay",
      "M&S": "M&S", "M&s": "M&S", "Marks & Spencer": "M&S",
      "Lidl": "Lidl",
      "Holland & Barrett": "Holland & Barrett",
      "Taste Inc": "Taste Inc", "Taste Inc. Protein": "Taste Inc",
      "Birds Eye": "Birds Eye",
    };
    const KNOWN_STORES = new Set(Object.keys(STORE_MAP));

    const items = [];
    const cards = document.querySelectorAll(".product-item");

    for (const card of cards) {
      const raw = (card.innerText || card.textContent || "").trim();
      if (!raw) continue;

      const lines = raw.split(/\n/).map(l => l.trim()).filter(Boolean);

      // Price line — exactly £X.XX
      const priceLineIdx = lines.findIndex(l => /^£[\d]+\.[\d]{2}$/.test(l));
      if (priceLineIdx === -1) continue;

      const price = lines[priceLineIdx];

      // Unit price — next line if it contains "per"
      const unitLine = lines[priceLineIdx + 1] || "";
      const unit = /per/.test(unitLine) ? unitLine : "";

      // Store — first line before price matching a known store
      let store = "Other";
      let storeLineIdx = -1;
      for (let i = 0; i < priceLineIdx; i++) {
        if (KNOWN_STORES.has(lines[i])) {
          store = STORE_MAP[lines[i]];
          storeLineIdx = i;
          break;
        }
      }

      // Product name — longest non-numeric, non-size, non-store line before price
      let productName = null;
      for (let i = 0; i < priceLineIdx; i++) {
        if (i === storeLineIdx) continue;
        if (/^\d+$/.test(lines[i])) continue;
        if (/^\d+(g|ml|kg|l|L)$/.test(lines[i])) continue;
        if (lines[i].length < 4) continue;
        if (!productName || lines[i].length > productName.length) {
          productName = lines[i];
        }
      }

      if (!productName) continue;
      items.push({ name: productName.slice(0, 150), store, price, unit });
    }

    // Deduplicate
    const seen = new Map();
    for (const item of items) {
      const key = `${item.name}|${item.store}|${item.price}`;
      if (!seen.has(key)) seen.set(key, item);
    }
    return [...seen.values()];
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH TROLLEY
// Loads the page then clicks "More Results" up to (clicks) times.
// Each click appends ~20 more products to the DOM.
// Default clicks=4 gives ~100 products (1 initial load + 4 clicks).
// ─────────────────────────────────────────────────────────────────────────────
async function searchTrolley(query, clicks = 4) {
  const { page, ctx } = await newPage();
  try {
    await page.goto(
      `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`,
      { waitUntil: "domcontentloaded", timeout: 25000 }
    );

    // Wait for first batch of products
    await Promise.race([
      page.waitForSelector(".product-item", { timeout: 10000 }),
      page.waitForTimeout(8000),
    ]).catch(() => {});
    await page.waitForTimeout(1500);

    const initialCount = await page.$$eval(".product-item", els => els.length);
    console.log(`  Trolley initial: ${initialCount} products`);

    // Click "More Results" / "Show More" button repeatedly
    // Trolley uses class search_more-results (seen in debug classes)
    const MORE_BTN = ".search_more-results, [class*='more-results'], [class*='load-more'], [class*='show-more']";

    for (let i = 0; i < clicks; i++) {
      const btn = await page.$(MORE_BTN);
      if (!btn) {
        console.log(`  Trolley: no more-results button at click ${i + 1}, stopping`);
        break;
      }

      const prevCount = await page.$$eval(".product-item", els => els.length);

      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click().catch(() => {});

      // Wait for new products to appear (count increases)
      await page.waitForFunction(
        (prev, sel) => document.querySelectorAll(sel).length > prev,
        { timeout: 8000 },
        prevCount,
        ".product-item"
      ).catch(() => {});

      await page.waitForTimeout(800);

      const newCount = await page.$$eval(".product-item", els => els.length);
      console.log(`  Trolley click ${i + 1}: ${newCount} products`);

      if (newCount === prevCount) {
        console.log(`  Trolley: no new products loaded, stopping`);
        break;
      }
    }

    const results = await scrapeTrolley(page);
    console.log(`  Trolley total: ${results.length}`);
    return results;
  } catch (err) {
    console.log(`  Trolley error: ${err.message}`);
    return [];
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AGGREGATE
// ─────────────────────────────────────────────────────────────────────────────
async function searchAll(query, clicks = 4) {
  console.log(`\nSearching: "${query}" (up to ${clicks} load-more clicks)`);
  const results = await searchTrolley(query, clicks);
  const byStore = {};
  for (const r of results) byStore[r.store] = (byStore[r.store] || 0) + 1;
  console.log("  By store:", JSON.stringify(byStore));
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get("/", (_, res) => {
  res.send(
    "Grocery price API\n" +
    "  GET  /search?q=milk[&clicks=4]\n" +
    "  POST /compare  { items: ['milk','bread'], clicks: 4 }\n" +
    "  GET  /debug?q=chicken"
  );
});

app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing ?q= param" });
  const clicks = Math.min(parseInt(req.query.clicks) || 4, 10);
  try {
    const results = await searchAll(query, clicks);
    res.json({ query, clicks, total: results.length, results, cheapest: findCheapest(results) });
  } catch (err) {
    console.error("ERROR /search:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/compare", async (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : body.q ? [body.q] : [];
  if (!items.length)
    return res.status(400).json({ error: 'Send { "items": ["milk","bread"] }' });
  const clicks = Math.min(parseInt(body.clicks) || 4, 10);
  try {
    const itemResults = await Promise.all(
      items.map(async (q) => {
        try {
          const results = await searchAll(q, clicks);
          return { query: q, total: results.length, results, cheapest: findCheapest(results) };
        } catch (err) {
          return { query: q, total: 0, results: [], cheapest: null, error: err.message };
        }
      })
    );
    res.json({ clicks, items: itemResults });
  } catch (err) {
    console.error("ERROR /compare:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DEBUG
// ─────────────────────────────────────────────────────────────────────────────
app.get("/debug", async (req, res) => {
  const query = req.query.q || "milk";
  const { page, ctx } = await newPage();
  try {
    const url = `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await Promise.race([
      page.waitForSelector(".product-item", { timeout: 10000 }),
      page.waitForTimeout(8000),
    ]).catch(() => {});
    await page.waitForTimeout(2000);

    const { relevantClasses, bodyTextSample, cardCount } = await page.evaluate(() => {
      const classSet = new Set();
      document.querySelectorAll("*").forEach((el) => {
        el.classList.forEach((c) => {
          if (/price|product|store|retailer|card|listing|result|search|item|more|load/i.test(c))
            classSet.add(c);
        });
      });
      return {
        relevantClasses: [...classSet].sort(),
        bodyTextSample: (document.body.innerText || "").slice(0, 3000),
        cardCount: document.querySelectorAll(".product-item").length,
      };
    });

    const domResults = await scrapeTrolley(page);

    res.json({
      query, url, cardCount, relevantClasses,
      domResultCount: domResults.length,
      domResultsSample: domResults.slice(0, 15),
      bodyTextSample,
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