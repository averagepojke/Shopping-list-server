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

/**
 * Extract the best image URL from a Next.js product card.
 *
 * Trolley is a Next.js app. next/image wraps real URLs in:
 *   /_next/image?url=<encoded-real-url>&w=96&q=75
 *
 * Before IntersectionObserver fires (lazy load), img.src is a tiny base64
 * blurred placeholder. The real URL is always available in:
 *   img.srcset  →  "/_next/image?url=...&w=96 1x, /_next/image?url=...&w=128 2x"
 *   <source srcset="..."> inside a <picture> wrapper
 *
 * We decode the `url` param to get the actual CDN image URL.
 */
function extractImageUrl(card) {
  // Helper: decode a Next.js image proxy URL → real CDN URL
  const decodeNextImage = (nextUrl) => {
    if (!nextUrl) return null;
    try {
      // Could be relative /_next/image?url=... or absolute
      const base = nextUrl.startsWith("http") ? nextUrl : `https://www.trolley.co.uk${nextUrl}`;
      const parsed = new URL(base);
      const realUrl = parsed.searchParams.get("url");
      return realUrl ? decodeURIComponent(realUrl) : null;
    } catch {
      return null;
    }
  };

  // Helper: pick the largest width from a srcset string and decode it
  const bestFromSrcset = (srcset) => {
    if (!srcset) return null;
    // srcset entries: "url w1x, url2 w2x"  or  "url 96w, url2 128w"
    const entries = srcset.split(",").map(s => s.trim()).filter(Boolean);
    if (!entries.length) return null;
    // Take the last entry (largest)
    const url = entries[entries.length - 1].split(/\s+/)[0];
    return url || null;
  };

  // 1. Try <picture><source srcset="..."> — most reliable for Next.js
  const source = card.querySelector("picture source");
  if (source) {
    const srcset = source.srcset || source.getAttribute("srcset");
    const url = bestFromSrcset(srcset);
    if (url) {
      const decoded = decodeNextImage(url) || url;
      if (decoded && !decoded.startsWith("data:")) return decoded;
    }
  }

  // 2. Try img srcset
  const img = card.querySelector("img");
  if (img) {
    const srcset = img.srcset || img.getAttribute("srcset");
    const url = bestFromSrcset(srcset);
    if (url) {
      const decoded = decodeNextImage(url) || url;
      if (decoded && !decoded.startsWith("data:")) return decoded;
    }

    // 3. Try img.src — only useful if IntersectionObserver already fired
    if (img.src && !img.src.startsWith("data:")) {
      const decoded = decodeNextImage(img.src) || img.src;
      if (decoded && decoded.startsWith("http")) return decoded;
    }

    // 4. data attributes (some lazy loaders)
    const lazy = img.dataset.src || img.dataset.lazySrc || img.dataset.srcset;
    if (lazy && !lazy.startsWith("data:")) {
      const decoded = decodeNextImage(lazy) || lazy;
      if (decoded) return decoded;
    }
  }

  return null;
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

  // Block only fonts/media/stylesheets — allow images so next/image loads
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
// SCROLL-TO-LOAD — trigger IntersectionObserver for lazy images
// Scrolls through the page in steps so all product images fire their lazy load
// ─────────────────────────────────────────────────────────────────────────────
async function triggerLazyImages(page) {
  await page.evaluate(async () => {
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    const totalHeight = document.body.scrollHeight;
    const step = Math.floor(window.innerHeight * 0.8);
    for (let y = 0; y < totalHeight; y += step) {
      window.scrollTo(0, y);
      await delay(120); // small pause for IntersectionObserver callbacks
    }
    window.scrollTo(0, 0);
  });
  // Give network a moment to respond to triggered image loads
  await page.waitForTimeout(600);
}

// ─────────────────────────────────────────────────────────────────────────────
// TROLLEY DOM SCRAPER
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

    // ── Inline image extractor (runs in browser context) ──────────────────
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

      // 1. <picture><source srcset>
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
        // 2. img srcset
        const srcset = img.srcset || img.getAttribute("srcset");
        const url = bestFromSrcset(srcset);
        if (url) {
          const decoded = decodeNextImage(url) || url;
          if (decoded && !decoded.startsWith("data:")) return decoded;
        }

        // 3. img.src (only once lazy-loaded)
        if (img.src && !img.src.startsWith("data:")) {
          const decoded = decodeNextImage(img.src) || img.src;
          if (decoded && decoded.startsWith("http")) return decoded;
        }

        // 4. data-* lazy attributes
        const lazy = img.dataset.src || img.dataset.lazySrc || img.dataset.srcset;
        if (lazy && !lazy.startsWith("data:")) {
          return decodeNextImage(lazy) || lazy;
        }
      }

      return null;
    }
    // ─────────────────────────────────────────────────────────────────────

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

      let store = "Other";
      let storeLineIdx = -1;
      for (let i = 0; i < priceLineIdx; i++) {
        if (KNOWN_STORES.has(lines[i])) {
          store = STORE_MAP[lines[i]];
          storeLineIdx = i;
          break;
        }
      }

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

      const imageUrl = extractImageUrl(card);

      items.push({
        name: productName.slice(0, 150),
        store,
        price,
        unit,
        imageUrl: imageUrl || null,
      });
    }

    const seen = new Map();
    for (const item of items) {
      const key = `${item.name}|${item.store}|${item.price}`;
      if (!seen.has(key)) seen.set(key, item);
    }
    return [...seen.values()];
  });
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

    // Scroll to trigger lazy image loading, then scroll back
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

      // Log image extraction success rate for debugging
      const withImages = newItems.filter(r => r.imageUrl).length;
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

      // Scroll to trigger lazy images on newly loaded cards
      await triggerLazyImages(page);

      const newCount = await page.$$eval(".product-item", els => els.length);
      console.log(`  Trolley click ${i + 1}: ${newCount} products`);

      const isLast = i === clicks - 1;
      const added = await emitBatch(isLast);

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
// AGGREGATE
// ─────────────────────────────────────────────────────────────────────────────
async function searchAll(query, clicks = 4, onBatch = null) {
  console.log(`\nSearching: "${query}" (up to ${clicks} load-more clicks)`);
  const results = await searchTrolley(query, clicks, onBatch);
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
    "  GET  /search/stream?q=milk[&clicks=4]   ← SSE streaming\n" +
    "  POST /compare  { items: ['milk','bread'], clicks: 4 }\n" +
    "  GET  /debug-images?q=milk               ← inspect image extraction\n" +
    "  GET  /debug?q=chicken"
  );
});

// ── Non-streaming search ───────────────────────────────────────────────────
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

// ── SSE streaming search ───────────────────────────────────────────────────
app.get("/search/stream", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing ?q= param" });
  const clicks = Math.min(parseInt(req.query.clicks) || 4, 10);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
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

// ── Debug: raw image extraction report ────────────────────────────────────
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

    // Report BEFORE scroll
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

    // Scroll to trigger lazy load
    await triggerLazyImages(page);

    // Report AFTER scroll
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

    // Full scrape
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
        name: r.name,
        store: r.store,
        price: r.price,
        imageUrl: r.imageUrl,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await ctx.close().catch(() => {});
  }
});

// ── Debug: general DOM inspection ─────────────────────────────────────────
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