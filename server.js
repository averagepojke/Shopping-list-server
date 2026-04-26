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
    ? { store: best.store, price: best.price, name: best.name, unit: best.unit || "", imageUrl: best.imageUrl || null }
    : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRICE CACHE
// In-memory cache keyed by normalised query string.
// Each entry: { results, cheapest, cachedAt }
// TTL: 2 hours — prices are unlikely to change faster than that.
// In-flight deduplication: if the same query is already being scraped,
// subsequent requests wait for the first one to finish rather than
// launching a second browser session.
// ─────────────────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const priceCache = new Map();   // query → { results, cheapest, cachedAt }
const inFlight   = new Map();   // query → Promise<{ results, cheapest }>

function cacheKey(query) {
  return query.trim().toLowerCase();
}

function getCached(query) {
  const entry = priceCache.get(cacheKey(query));
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    priceCache.delete(cacheKey(query));
    return null;
  }
  return entry;
}

function setCached(query, results, cheapest) {
  priceCache.set(cacheKey(query), { results, cheapest, cachedAt: Date.now() });
}

// ─────────────────────────────────────────────────────────────────────────────
// STORE RESOLUTION
// Exact map first, then keyword matching so sub-brands ("Tesco Finest",
// "Sainsbury's Taste the Difference", etc.) always resolve to a known store.
// ─────────────────────────────────────────────────────────────────────────────

const STORE_MAP = {
  // Asda
  "Asda": "Asda", "ASDA": "Asda",
  "Exceptional by ASDA": "Asda", "Exceptional By Asda": "Asda",
  "George at ASDA": "Asda", "George at Asda": "Asda",
  "Asda Extra Special": "Asda", "ASDA Extra Special": "Asda",
  "Smart Price": "Asda",

  // Tesco
  "Tesco": "Tesco", "TESCO": "Tesco",
  "Tesco Finest": "Tesco", "Tesco Everyday Value": "Tesco",
  "Tesco Free From": "Tesco", "Tesco Plant Chef": "Tesco",
  "Tesco Organic": "Tesco", "Tesco Loves Kids": "Tesco",
  "Tesco Healthy Living": "Tesco", "Tesco Light Choices": "Tesco",

  // Sainsbury's
  "Sainsbury's": "Sainsbury's", "Sainsburys": "Sainsbury's",
  "Sainsbury's Taste the Difference": "Sainsbury's", "Taste the Difference": "Sainsbury's",
  "Sainsbury's by Sainsbury's": "Sainsbury's",
  "Sainsbury's Free From": "Sainsbury's", "Sainsbury's Organic": "Sainsbury's",
  "Sainsbury's SO Organic": "Sainsbury's", "SO Organic": "Sainsbury's",
  "Sainsbury's Kids": "Sainsbury's",

  // Morrisons
  "Morrisons": "Morrisons", "MORRISONS": "Morrisons",
  "Morrisons Savers": "Morrisons", "Morrisons The Best": "Morrisons",
  "The Best": "Morrisons", "M Savers": "Morrisons",
  "Morrisons Free From": "Morrisons", "Morrisons Market Street": "Morrisons",
  "Morrisons Nutmeg": "Morrisons", "Nutmeg": "Morrisons",

  // Co-op
  "Co-op": "Co-op", "Coop": "Co-op", "The Co-operative": "Co-op",
  "Co-operative": "Co-op", "Co op": "Co-op", "CO-OP": "Co-op",
  "Co-op Loved by Us": "Co-op", "Loved by Us": "Co-op",
  "Co-op Irresistible": "Co-op", "Irresistible": "Co-op",

  // Iceland
  "Iceland": "Iceland", "ICELAND": "Iceland",
  "The Food Warehouse": "Iceland", "Food Warehouse": "Iceland",
  "Iceland Foods": "Iceland",

  // Waitrose
  "Waitrose": "Waitrose", "WAITROSE": "Waitrose",
  "Waitrose Ltd": "Waitrose", "Waitrose & Partners": "Waitrose",
  "Waitrose Essential": "Waitrose", "Waitrose Essentials": "Waitrose",
  "Waitrose duchy": "Waitrose", "Duchy Originals": "Waitrose",
  "Waitrose Free From": "Waitrose", "Little Waitrose": "Waitrose",

  // Aldi
  "ALDI": "Aldi", "Aldi": "Aldi",
  "Specially Selected": "Aldi", "Everyday Essentials": "Aldi",
  "Just Essentials": "Aldi", "Aldi Specially Selected": "Aldi",
  "Belmont": "Aldi", "Village Bakery": "Aldi",

  // Lidl
  "Lidl": "Lidl", "LIDL": "Lidl",
  "Lidl Plus": "Lidl", "Deluxe": "Lidl",
  "Milbona": "Lidl", "Favorina": "Lidl", "Crestline": "Lidl",

  // M&S
  "M&S": "M&S", "M&s": "M&S", "Marks & Spencer": "M&S",
  "Marks and Spencer": "M&S", "M & S": "M&S",
  "M&S Food": "M&S", "M&S Simply Food": "M&S",
  "Per Una": "M&S", "M&S Collection": "M&S",

  // Ocado
  "Ocado": "Ocado", "OCADO": "Ocado", "Ocado Own": "Ocado",

  // Boots
  "Boots": "Boots", "BOOTS": "Boots",
  "Boots Pharmaceuticals": "Boots", "Boots Own": "Boots",
  "No7": "Boots", "Soap & Glory": "Boots",

  // Superdrug
  "Superdrug": "Superdrug", "SUPERDRUG": "Superdrug",
  "B. by Superdrug": "Superdrug", "Studio London": "Superdrug",

  // B&M
  "B&M": "B&M", "B&M Bargains": "B&M", "B & M": "B&M",

  // Poundland
  "Poundland": "Poundland", "POUNDLAND": "Poundland",

  // Savers
  "Savers": "Savers",

  // Holland & Barrett
  "Holland & Barrett": "Holland & Barrett", "Holland and Barrett": "Holland & Barrett",
  "H&B": "Holland & Barrett",

  // Amazon
  "Amazon": "Amazon", "AMAZON": "Amazon",
  "Amazon Fresh": "Amazon", "Amazon Pantry": "Amazon", "Solimo": "Amazon",

  // eBay
  "Ebay": "eBay", "eBay": "eBay", "EBAY": "eBay",

  // Others
  "Birds Eye": "Birds Eye",
  "Taste Inc": "Taste Inc", "Taste Inc. Protein": "Taste Inc",
  "Farmfoods": "Farmfoods", "FARMFOODS": "Farmfoods",
  "Home Bargains": "Home Bargains",
  "Wilko": "Wilko", "WILKO": "Wilko",
  "Costco": "Costco",
  "Spar": "Spar", "SPAR": "Spar",
  "Londis": "Londis",
  "Budgens": "Budgens",
  "Nisa": "Nisa", "NISA": "Nisa",
  "Premier": "Premier",
  "McColl's": "McColl's",
  "One Stop": "One Stop",
  "Netto": "Netto",
};

// Keyword fragments → canonical store name, checked in order.
// Used when exact match fails — tested against lowercased raw store text.
const STORE_KEYWORDS = [
  ["asda", "Asda"],
  ["tesco", "Tesco"],
  ["sainsbury", "Sainsbury's"],
  ["morrisons", "Morrisons"],
  ["co-op", "Co-op"],
  ["coop", "Co-op"],
  ["co op", "Co-op"],
  ["cooperative", "Co-op"],
  ["iceland", "Iceland"],
  ["food warehouse", "Iceland"],
  ["waitrose", "Waitrose"],
  ["duchy", "Waitrose"],
  ["aldi", "Aldi"],
  ["lidl", "Lidl"],
  ["marks & spencer", "M&S"],
  ["marks and spencer", "M&S"],
  ["m&s", "M&S"],
  ["ocado", "Ocado"],
  ["boots", "Boots"],
  ["superdrug", "Superdrug"],
  ["b&m", "B&M"],
  ["poundland", "Poundland"],
  ["holland & barrett", "Holland & Barrett"],
  ["holland and barrett", "Holland & Barrett"],
  ["amazon", "Amazon"],
  ["ebay", "eBay"],
  ["farmfoods", "Farmfoods"],
  ["home bargains", "Home Bargains"],
  ["wilko", "Wilko"],
  ["costco", "Costco"],
  ["spar", "Spar"],
  ["londis", "Londis"],
  ["budgens", "Budgens"],
  ["nisa", "Nisa"],
  ["savers", "Savers"],
  ["birds eye", "Birds Eye"],
  ["taste inc", "Taste Inc"],
  ["one stop", "One Stop"],
  ["mccoll", "McColl's"],
];

/**
 * Resolve a raw store string to a canonical store name.
 * 1. Exact match in STORE_MAP
 * 2. Keyword substring match (case-insensitive)
 * 3. Return the raw string capitalised — never "Other"
 */
function resolveStore(raw) {
  if (!raw || !raw.trim()) return "Unknown";
  const trimmed = raw.trim();

  // 1. Exact match
  if (STORE_MAP[trimmed]) return STORE_MAP[trimmed];

  // 2. Keyword match
  const lower = trimmed.toLowerCase();
  for (const [kw, canonical] of STORE_KEYWORDS) {
    if (lower.includes(kw)) return canonical;
  }

  // 3. Keep the raw value — better than "Other"
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// BROWSER
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
    const type = route.request().resourceType();
    if (["font", "media", "stylesheet"].includes(type)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  return { page, ctx };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCROLL-TO-LOAD
// ─────────────────────────────────────────────────────────────────────────────
async function triggerLazyImages(page) {
  await page.evaluate(async () => {
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    const totalHeight = document.body.scrollHeight;
    const step = Math.floor(window.innerHeight * 0.8);
    for (let y = 0; y < totalHeight; y += step) {
      window.scrollTo(0, y);
      await delay(120);
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(600);
}

// ─────────────────────────────────────────────────────────────────────────────
// TROLLEY DOM SCRAPER
// Raw store text is returned from the browser, then resolved server-side
// using the full STORE_MAP / STORE_KEYWORDS without serialising them.
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeTrolley(page) {
  const rawItems = await page.evaluate(() => {
    function extractImageUrl(card) {
      const decodeNextImage = (nextUrl) => {
        if (!nextUrl) return null;
        try {
          const base = nextUrl.startsWith("http")
            ? nextUrl
            : `https://www.trolley.co.uk${nextUrl}`;
          const parsed = new URL(base);
          const realUrl = parsed.searchParams.get("url");
          return realUrl ? decodeURIComponent(realUrl) : null;
        } catch { return null; }
      };

      const bestFromSrcset = (srcset) => {
        if (!srcset) return null;
        const entries = srcset.split(",").map(s => s.trim()).filter(Boolean);
        if (!entries.length) return null;
        const url = entries[entries.length - 1].split(/\s+/)[0];
        return url || null;
      };

      const source = card.querySelector("picture source");
      if (source) {
        const url = bestFromSrcset(source.srcset || source.getAttribute("srcset"));
        if (url) {
          const decoded = decodeNextImage(url) || url;
          if (decoded && !decoded.startsWith("data:")) return decoded;
        }
      }

      const img = card.querySelector("img");
      if (img) {
        const srcset = img.srcset || img.getAttribute("srcset");
        const url = bestFromSrcset(srcset);
        if (url) {
          const decoded = decodeNextImage(url) || url;
          if (decoded && !decoded.startsWith("data:")) return decoded;
        }
        if (img.src && !img.src.startsWith("data:")) {
          const decoded = decodeNextImage(img.src) || img.src;
          if (decoded && decoded.startsWith("http")) return decoded;
        }
        const lazy = img.dataset.src || img.dataset.lazySrc || img.dataset.srcset;
        if (lazy && !lazy.startsWith("data:")) {
          return decodeNextImage(lazy) || lazy;
        }
      }
      return null;
    }

    const items = [];
    const cards = document.querySelectorAll(".product-item");

    for (const card of cards) {
      const raw = (card.innerText || card.textContent || "").trim();
      if (!raw) continue;

      const lines = raw.split(/\n/).map(l => l.trim()).filter(Boolean);
      const priceLineIdx = lines.findIndex(l => /^£[\d]+\.[\d]{2}$/.test(l));
      if (priceLineIdx === -1) continue;

      const price = lines[priceLineIdx];
      const unitLine = lines[priceLineIdx + 1] || "";
      const unit = /per/.test(unitLine) ? unitLine : "";

      // Grab the raw store text — resolved server-side
      let rawStore = "";
      let storeLineIdx = -1;
      for (let i = 0; i < priceLineIdx && i <= 2; i++) {
        const l = lines[i];
        if (/^\d+$/.test(l)) continue;
        if (/^\d+(g|ml|kg|l|L)$/i.test(l)) continue;
        if (l.length >= 2 && l.length <= 50) {
          rawStore = l;
          storeLineIdx = i;
          break;
        }
      }

      let productName = null;
      for (let i = 0; i < priceLineIdx; i++) {
        if (i === storeLineIdx) continue;
        if (/^\d+$/.test(lines[i])) continue;
        if (/^\d+(g|ml|kg|l|L)$/i.test(lines[i])) continue;
        if (lines[i].length < 4) continue;
        if (!productName || lines[i].length > productName.length) {
          productName = lines[i];
        }
      }

      if (!productName) continue;

      items.push({
        name: productName.slice(0, 150),
        rawStore,
        price,
        unit,
        imageUrl: extractImageUrl(card) || null,
      });
    }

    const seen = new Map();
    for (const item of items) {
      const key = `${item.name}|${item.rawStore}|${item.price}`;
      if (!seen.has(key)) seen.set(key, item);
    }
    return [...seen.values()];
  });

  // Resolve stores server-side
  return rawItems.map(item => ({
    name: item.name,
    store: resolveStore(item.rawStore),
    price: item.price,
    unit: item.unit,
    imageUrl: item.imageUrl,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH TROLLEY — SSE streaming
// ─────────────────────────────────────────────────────────────────────────────
async function searchTrolley(query, clicks = 4, onBatch = null) {
  const { page, ctx } = await newPage();
  try {
    await page.goto(
      `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`,
      { waitUntil: "domcontentloaded", timeout: 25000 }
    );

    await Promise.race([
      page.waitForSelector(".product-item", { timeout: 10000 }),
      page.waitForTimeout(8000),
    ]).catch(() => {});

    await triggerLazyImages(page);

    const initialCount = await page.$$eval(".product-item", els => els.length);
    console.log(`  Trolley initial: ${initialCount} products`);

    const seen = new Set();
    let allResults = [];

    const emitBatch = async (isLast = false) => {
      const current = await scrapeTrolley(page);
      const newItems = current.filter(r => {
        const key = `${r.name}|${r.store}|${r.price}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const withImages = newItems.filter(r => r.imageUrl).length;
      // Log any store names that still didn't resolve to a known canonical
      const allCanonical = new Set([...Object.values(STORE_MAP), ...STORE_KEYWORDS.map(([,c]) => c)]);
      const unresolved = [...new Set(newItems.map(r => r.store).filter(s => !allCanonical.has(s)))];
      if (unresolved.length) console.log(`  Unresolved stores (will add to map): ${unresolved.join(", ")}`);

      console.log(`  Batch: ${newItems.length} new items, ${withImages} with images`);

      allResults = [...allResults, ...newItems];
      if (onBatch && newItems.length > 0) {
        onBatch(newItems, allResults, isLast);
      }
      return newItems.length;
    };

    await emitBatch(clicks === 0);

    const MORE_BTN = ".search_more-results, [class*='more-results'], [class*='load-more'], [class*='show-more']";

    for (let i = 0; i < clicks; i++) {
      const btn = await page.$(MORE_BTN);
      if (!btn) {
        console.log(`  Trolley: no more-results button at click ${i + 1}, stopping`);
        if (onBatch) onBatch([], allResults, true);
        break;
      }

      const prevCount = await page.$$eval(".product-item", els => els.length);
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click().catch(() => {});

      await page.waitForFunction(
        (prev, sel) => document.querySelectorAll(sel).length > prev,
        { timeout: 8000 },
        prevCount,
        ".product-item"
      ).catch(() => {});

      await triggerLazyImages(page);

      const newCount = await page.$$eval(".product-item", els => els.length);
      console.log(`  Trolley click ${i + 1}: ${newCount} products`);

      const isLast = i === clicks - 1;
      await emitBatch(isLast);

      if (newCount === prevCount) {
        console.log(`  Trolley: no new products loaded, stopping`);
        if (onBatch) onBatch([], allResults, true);
        break;
      }
    }

    console.log(`  Trolley total: ${allResults.length}`);
    return allResults;
  } catch (err) {
    console.log(`  Trolley error: ${err.message}`);
    if (onBatch) onBatch([], [], true);
    return [];
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AGGREGATE  (with cache + in-flight deduplication)
// ─────────────────────────────────────────────────────────────────────────────
async function searchAll(query, clicks = 4, onBatch = null) {
  const key = cacheKey(query);

  // ── Cache hit: replay results instantly via onBatch then return ───────────
  const cached = getCached(query);
  if (cached) {
    const ageMin = Math.round((Date.now() - cached.cachedAt) / 60000);
    console.log(`\nCache HIT "${query}" (${ageMin}m old, ${cached.results.length} results)`);
    if (onBatch) onBatch(cached.results, cached.results, true);
    return cached.results;
  }

  // ── In-flight deduplication: if scrape is already running, wait for it ───
  if (inFlight.has(key)) {
    console.log(`\nIn-flight HIT "${query}" — waiting for existing scrape`);
    const { results, cheapest } = await inFlight.get(key);
    if (onBatch) onBatch(results, results, true);
    return results;
  }

  // ── Cache miss: scrape and populate cache ────────────────────────────────
  console.log(`\nCache MISS "${query}" — scraping (up to ${clicks} load-more clicks)`);

  let resolveFlight, rejectFlight;
  const flightPromise = new Promise((res, rej) => { resolveFlight = res; rejectFlight = rej; });
  inFlight.set(key, flightPromise);

  try {
    const results = await searchTrolley(query, clicks, onBatch);
    const cheapest = findCheapest(results);
    setCached(query, results, cheapest);

    const byStore = {};
    for (const r of results) byStore[r.store] = (byStore[r.store] || 0) + 1;
    console.log("  By store:", JSON.stringify(byStore));

    resolveFlight({ results, cheapest });
    return results;
  } catch (err) {
    rejectFlight(err);
    throw err;
  } finally {
    inFlight.delete(key);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get("/", (_, res) => {
  res.send(
    "Grocery price API\n" +
    "  GET  /search?q=milk[&clicks=4]\n" +
    "  GET  /search/stream?q=milk[&clicks=4]   ← SSE streaming\n" +
    "  POST /compare  { items: ['milk','bread'], clicks: 4 }\n" +
    "  GET  /cache                             ← list cached queries\n" +
    "  DEL  /cache                             ← clear all cache\n" +
    "  DEL  /cache?q=milk                      ← clear one entry\n" +
    "  GET  /debug-stores?q=milk\n" +
    "  GET  /debug-images?q=milk\n" +
    "  GET  /debug?q=chicken"
  );
});

// ── Cache inspection / management ─────────────────────────────────────────
app.get("/cache", (req, res) => {
  const now = Date.now();
  const entries = [...priceCache.entries()].map(([key, entry]) => ({
    query: key,
    results: entry.results.length,
    cachedAt: new Date(entry.cachedAt).toISOString(),
    ageMinutes: Math.round((now - entry.cachedAt) / 60000),
    expiresInMinutes: Math.round((CACHE_TTL_MS - (now - entry.cachedAt)) / 60000),
  }));
  res.json({
    entries: entries.length,
    ttlHours: CACHE_TTL_MS / 3600000,
    inFlight: [...inFlight.keys()],
    cache: entries,
  });
});

app.delete("/cache", (req, res) => {
  if (req.query.q) {
    const key = cacheKey(req.query.q);
    const existed = priceCache.has(key);
    priceCache.delete(key);
    return res.json({ cleared: existed ? [key] : [], total: priceCache.size });
  }
  const keys = [...priceCache.keys()];
  priceCache.clear();
  res.json({ cleared: keys, total: 0 });
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

app.get("/search/stream", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing ?q= param" });
  const clicks = Math.min(parseInt(req.query.clicks) || 4, 10);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  // Let the client know if this is a cache hit (results arrive instantly)
  res.setHeader("X-Cache", getCached(query) ? "HIT" : "MISS");
  res.flushHeaders();
  res.write(": connected\n\n");

  const send = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
    if (typeof res.flush === "function") res.flush();
    else if (res.socket && typeof res.socket.flush === "function") res.socket.flush();
  };

  try {
    await searchAll(query, clicks, (newItems, allResults, done) => {
      send({
        type: "batch",
        items: newItems,
        total: allResults.length,
        cheapest: findCheapest(allResults),
        done,
      });
    });
  } catch (err) {
    send({ type: "error", message: err.message });
  } finally {
    res.end();
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

// ── Debug: raw vs resolved store names ────────────────────────────────────
// Hit /debug-stores?q=chicken to see what raw text Trolley shows and how
// it resolves. Any "Unresolved" entries should be added to STORE_MAP.
app.get("/debug-stores", async (req, res) => {
  const query = req.query.q || "milk";
  const { page, ctx } = await newPage();
  try {
    await page.goto(
      `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`,
      { waitUntil: "domcontentloaded", timeout: 25000 }
    );
    await Promise.race([
      page.waitForSelector(".product-item", { timeout: 10000 }),
      page.waitForTimeout(8000),
    ]).catch(() => {});
    await triggerLazyImages(page);

    const rawStores = await page.evaluate(() => {
      const stores = [];
      for (const card of document.querySelectorAll(".product-item")) {
        const lines = (card.innerText || "").split(/\n/).map(l => l.trim()).filter(Boolean);
        const priceIdx = lines.findIndex(l => /^£[\d]+\.[\d]{2}$/.test(l));
        if (priceIdx === -1) continue;
        for (let i = 0; i < priceIdx && i <= 2; i++) {
          const l = lines[i];
          if (l.length >= 2 && l.length <= 50 && !/^\d/.test(l)) {
            stores.push(l);
            break;
          }
        }
      }
      return stores;
    });

    const freq = {};
    for (const s of rawStores) freq[s] = (freq[s] || 0) + 1;

    const allCanonical = new Set([...Object.values(STORE_MAP), ...STORE_KEYWORDS.map(([,c]) => c)]);
    const resolved = Object.entries(freq).map(([raw, count]) => {
      const r = resolveStore(raw);
      return { raw, resolved: r, count, known: allCanonical.has(r) };
    }).sort((a, b) => b.count - a.count);

    res.json({ query, totalCards: rawStores.length, stores: resolved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await ctx.close().catch(() => {});
  }
});

app.get("/debug-images", async (req, res) => {
  const query = req.query.q || "milk";
  const { page, ctx } = await newPage();
  try {
    await page.goto(
      `https://www.trolley.co.uk/search/?q=${encodeURIComponent(query)}`,
      { waitUntil: "domcontentloaded", timeout: 25000 }
    );
    await Promise.race([
      page.waitForSelector(".product-item", { timeout: 10000 }),
      page.waitForTimeout(8000),
    ]).catch(() => {});

    const beforeScroll = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".product-item")].slice(0, 3);
      return cards.map(card => {
        const img = card.querySelector("img");
        const source = card.querySelector("picture source");
        return {
          imgSrc: img?.src?.slice(0, 120) || null,
          imgSrcset: img?.srcset?.slice(0, 200) || null,
          sourceSrcset: source?.srcset?.slice(0, 200) || null,
          dataLazySrc: img?.dataset?.lazySrc || null,
          dataSrc: img?.dataset?.src || null,
        };
      });
    });

    await triggerLazyImages(page);

    const afterScroll = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".product-item")].slice(0, 3);
      return cards.map(card => {
        const img = card.querySelector("img");
        const source = card.querySelector("picture source");
        return {
          imgSrc: img?.src?.slice(0, 120) || null,
          imgSrcset: img?.srcset?.slice(0, 200) || null,
          sourceSrcset: source?.srcset?.slice(0, 200) || null,
        };
      });
    });

    const results = await scrapeTrolley(page);
    const withImages = results.filter(r => r.imageUrl).length;

    res.json({
      query,
      totalProducts: results.length,
      withImages,
      withoutImages: results.length - withImages,
      imageSuccessRate: results.length ? `${Math.round(withImages / results.length * 100)}%` : "0%",
      rawImgAttrsBeforeScroll: beforeScroll,
      rawImgAttrsAfterScroll: afterScroll,
      sampleResults: results.slice(0, 5).map(r => ({
        name: r.name, store: r.store, price: r.price, imageUrl: r.imageUrl,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await ctx.close().catch(() => {});
  }
});

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