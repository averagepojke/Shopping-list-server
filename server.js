const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const puppeteer = require("puppeteer");

const app = express();
app.use(cors());

// ---------------------------------------------------------------------------
// Shared browser-like headers
// ---------------------------------------------------------------------------
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
  "Accept-Encoding": "identity",
  Connection: "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Cache-Control": "max-age=0",
};

const GOL_API_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "en-GB,en;q=0.9",
  "X-Requested-With": "XMLHttpRequest",
  Referer: "https://www.sainsburys.co.uk/",
  Origin: "https://www.sainsburys.co.uk",
};

// ---------------------------------------------------------------------------
// Puppeteer browser pool
// ---------------------------------------------------------------------------
let browserInstance = null;

async function getBrowser() {
  if (!browserInstance || !browserInstance.connected) {
    browserInstance = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--window-size=1280,800",
      ],
    });
  }
  return browserInstance;
}

async function newPage() {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-GB,en;q=0.9" });
  await page.setViewport({ width: 1280, height: 800 });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image", "font", "media"].includes(type)) req.abort();
    else req.continue();
  });
  return page;
}

// ---------------------------------------------------------------------------
// Helper: safe fetch with timeout
// ---------------------------------------------------------------------------
async function safeFetch(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Sainsbury's
// ---------------------------------------------------------------------------
const SAINSBURYS_BASE =
  "https://www.sainsburys.co.uk/groceries-api/gol-services/product/v1/product";
const SAINSBURYS_STORE = "2168";

function parseSainsburysProducts(json, query) {
  const candidates =
    json?.products ??
    json?.data?.products ??
    json?.catalogue_products ??
    json?.results ??
    (Array.isArray(json?.data) ? json.data : null) ??
    [];

  const arr = Array.isArray(candidates) ? candidates : [];
  const results = [];
  const queryLower = query.toLowerCase();

  for (const p of arr) {
    if (results.length >= 3) break;
    const name =
      p.name ?? p.display_name ?? p.full_name ??
      p.product_info?.name ?? p.base_product_info?.name ?? "";
    const priceRaw =
      p.retail_price?.price ?? p.price ?? p.unit_price?.price ??
      p.current_retail_price ?? p.prices?.price?.value ?? null;

    if (!name || priceRaw == null) continue;
    if (!name.toLowerCase().includes(queryLower)) continue;

    const unit = p.unit_price?.measure ?? p.retail_price?.measure ?? "";
    results.push({
      name: name.trim().slice(0, 120),
      price: `£${Number(priceRaw).toFixed(2)}`,
      unit,
      store: "Sainsbury's",
    });
  }
  return results;
}

async function searchSainsburysDirect(query) {
  const q = encodeURIComponent(query);
  const s = SAINSBURYS_STORE;
  const endpoints = [
    `${SAINSBURYS_BASE}?filter%5Bkeyword%5D=${q}&page_size=9&store=${s}`,
    `${SAINSBURYS_BASE}?filter[keyword]=${q}&page_size=9&store=${s}`,
    `${SAINSBURYS_BASE}?keywords=${q}&page_size=9&store=${s}`,
    `${SAINSBURYS_BASE}?q=${q}&page_size=9&store=${s}`,
    `https://www.sainsburys.co.uk/groceries-api/gol-services/product/v2/product?filter%5Bkeyword%5D=${q}&page_size=9&store=${s}`,
  ];

  for (const url of endpoints) {
    try {
      const res = await safeFetch(url, { headers: GOL_API_HEADERS }, 10000);
      if (!res.ok) continue;
      const json = await res.json();
      const results = parseSainsburysProducts(json, query);
      if (results.length > 0) return results;
    } catch { /* try next */ }
  }
  return null;
}

async function searchSainsburysPuppeteer(query) {
  const page = await newPage();
  const results = [];

  return new Promise(async (resolve) => {
    const timeout = setTimeout(() => {
      page.close().catch(() => {});
      resolve([]);
    }, 30000);

    page.on("response", async (response) => {
      if (results.length >= 3) return;
      const url = response.url();
      if (!url.includes("groceries-api/gol-services/product")) return;
      const ct = response.headers()["content-type"] || "";
      if (!ct.includes("json")) return;
      try {
        const json = await response.json();
        const parsed = parseSainsburysProducts(json, query);
        results.push(...parsed.slice(0, 3 - results.length));
        if (results.length >= 1) {
          clearTimeout(timeout);
          await page.close().catch(() => {});
          resolve(results);
        }
      } catch { /* skip */ }
    });

    try {
      await page.goto(
        `https://www.sainsburys.co.uk/gol-ui/SearchDisplay?searchTerm=${encodeURIComponent(query)}&pageSize=9`,
        { waitUntil: "domcontentloaded", timeout: 25000 }
      );
    } catch {
      clearTimeout(timeout);
      await page.close().catch(() => {});
      resolve([]);
    }
  });
}

async function searchSainsburys(query) {
  const direct = await searchSainsburysDirect(query);
  if (direct !== null) return direct;
  return searchSainsburysPuppeteer(query);
}

// ---------------------------------------------------------------------------
// ASDA — Algolia
// ---------------------------------------------------------------------------
let asdaAlgoliaCache = null;

async function getAsdaAlgoliaCredentials() {
  if (asdaAlgoliaCache) return asdaAlgoliaCache;

  const page = await newPage();

  return new Promise(async (resolve) => {
    const timeout = setTimeout(async () => {
      await page.close().catch(() => {});
      resolve(null);
    }, 25000);

    page.removeAllListeners("request");
    await page.setRequestInterception(true);

    page.on("request", (req) => {
      const url = req.url();
      const type = req.resourceType();
      if (["image", "font", "media"].includes(type)) { req.abort(); return; }

      if (url.includes("algolia.net") && url.includes("/queries") && !asdaAlgoliaCache) {
        const headers = req.headers();
        const apiKey = headers["x-algolia-api-key"];
        const appId  = headers["x-algolia-application-id"];
        let indexName = null;
        try {
          const body = req.postData();
          if (body) {
            const parsed = JSON.parse(body);
            indexName = parsed?.requests?.[0]?.indexName ?? null;
          }
        } catch { /* ignore */ }

        if (apiKey && appId) {
          asdaAlgoliaCache = { apiKey, appId, indexName };
          clearTimeout(timeout);
          req.continue();
          page.close().catch(() => {});
          resolve(asdaAlgoliaCache);
          return;
        }
      }
      req.continue();
    });

    try {
      await page.goto("https://groceries.asda.com/search/milk", { waitUntil: "domcontentloaded", timeout: 20000 });
      await new Promise(r => setTimeout(r, 8000));
    } catch { /* ignore */ }

    if (!asdaAlgoliaCache) {
      clearTimeout(timeout);
      await page.close().catch(() => {});
      resolve(null);
    }
  });
}

async function algoliaSearch(appId, apiKey, indexName, query) {
  const body = JSON.stringify({
    requests: [{
      indexName,
      params: new URLSearchParams({
        query,
        hitsPerPage: "5",
        filters: "STATUS:A",
        attributesToRetrieve: "NAME,PRICES,BRAND",
        attributesToHighlight: "",
      }).toString(),
    }],
  });

  const url =
    `https://${appId.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries` +
    `?x-algolia-agent=Algolia%20for%20JavaScript%20(4.25.2)%3B%20Browser`;

  const res = await safeFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-algolia-application-id": appId,
      "x-algolia-api-key": apiKey,
    },
    body,
  });

  if (!res.ok) throw new Error(`Algolia HTTP ${res.status}`);
  return res.json();
}

function hitsToAsda(hits) {
  return hits.slice(0, 3).map((h) => ({
    name: (h.NAME ?? "Unknown").trim().slice(0, 120),
    price: h.PRICES?.EN?.PRICE != null
      ? `£${Number(h.PRICES.EN.PRICE).toFixed(2)}`
      : "N/A",
    unit: h.PRICES?.EN?.PRICEPERUOMFORMATTED ?? "",
    store: "ASDA",
  }));
}

async function searchAsda(query) {
  const creds = await getAsdaAlgoliaCredentials();
  if (!creds) return [];
  const indexName = creds.indexName ?? "prod_main";
  try {
    const json = await algoliaSearch(creds.appId, creds.apiKey, indexName, query);
    return hitsToAsda(json?.results?.[0]?.hits ?? []);
  } catch {
    asdaAlgoliaCache = null;
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tesco — xapi GraphQL via Puppeteer then replay
// ---------------------------------------------------------------------------
let tescoXapiCache = null;

async function getTescoXapiTemplate() {
  if (tescoXapiCache) return tescoXapiCache;

  const page = await newPage();

  return new Promise(async (resolve) => {
    const timeout = setTimeout(async () => {
      await page.close().catch(() => {});
      resolve(null);
    }, 40000);

    page.removeAllListeners("request");
    await page.setRequestInterception(true);

    page.on("request", (req) => {
      const url = req.url();
      const type = req.resourceType();
      if (["image", "font", "media"].includes(type)) { req.abort(); return; }

      if (url.includes("xapi.tesco.com") && req.method() === "POST" && !tescoXapiCache) {
        const headers = req.headers();
        let body = null;
        try { body = JSON.parse(req.postData() || "null"); } catch { /* ok */ }

        const hasSearch = Array.isArray(body)
          ? body.some(op => op?.operationName?.toLowerCase().includes("search") || op?.operationName?.toLowerCase().includes("product"))
          : body?.operationName?.toLowerCase().includes("search") || body?.operationName?.toLowerCase().includes("product");

        if (body && (hasSearch || Array.isArray(body))) {
          tescoXapiCache = { url, headers, body };
          clearTimeout(timeout);
          req.continue();
          page.close().catch(() => {});
          resolve(tescoXapiCache);
          return;
        }
      }
      req.continue();
    });

    try {
      await page.goto(
        "https://www.tesco.com/groceries/en-GB/search?query=milk&count=24",
        { waitUntil: "domcontentloaded", timeout: 30000 }
      );
      await new Promise(r => setTimeout(r, 15000));
    } catch { /* ignore */ }

    if (!tescoXapiCache) {
      clearTimeout(timeout);
      await page.close().catch(() => {});
      resolve(null);
    }
  });
}

function parseTescoXapi(json) {
  const results = [];
  const ops = Array.isArray(json) ? json : [json];
  for (const op of ops) {
    if (results.length >= 3) break;
    const items =
      op?.data?.productsSearch?.productItems ??
      op?.data?.productsByCategory?.productItems ??
      op?.data?.recommendations?.productItems ??
      [];
    for (const item of items) {
      if (results.length >= 3) break;
      const p = item?.product ?? item;
      const name = p?.name ?? p?.title ?? "";
      const price =
        p?.price?.actual ?? p?.price?.current ?? p?.price?.value ?? p?.unitPrice ?? null;
      if (!name || price == null) continue;
      results.push({
        name: String(name).trim().slice(0, 120),
        price: `£${Number(price).toFixed(2)}`,
        unit: p?.price?.unitOfMeasure ?? "",
        store: "Tesco",
      });
    }
  }
  return results;
}

function patchTescoBody(body, query) {
  const str = JSON.stringify(body);
  const patched = str.replace(/"query"\s*:\s*"[^"]*"/g, `"query":"${query.replace(/"/g, '\\"')}"`);
  return JSON.parse(patched);
}

async function searchTesco(query) {
  const template = await getTescoXapiTemplate();
  if (!template) return [];

  try {
    const patchedBody = patchTescoBody(template.body, query);
    const { host, "content-length": _cl, ...safeHeaders } = template.headers;

    const res = await safeFetch(template.url, {
      method: "POST",
      headers: { ...safeHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(patchedBody),
    }, 15000);

    if (!res.ok) {
      tescoXapiCache = null;
      return [];
    }

    const json = await res.json();
    return parseTescoXapi(json);
  } catch {
    tescoXapiCache = null;
    return [];
  }
}

// ---------------------------------------------------------------------------
// Morrisons
// ---------------------------------------------------------------------------
async function searchMorrisons(query) {
  const page = await newPage();
  const results = [];

  return new Promise(async (resolve) => {
    const timeout = setTimeout(() => {
      page.close().catch(() => {});
      resolve([]);
    }, 60000);

    page.removeAllListeners("request");
    await page.setRequestInterception(true);

    let sessionReady = false;

    page.on("request", async (req) => {
      const url = req.url();
      const type = req.resourceType();
      if (["image", "font", "media", "stylesheet"].includes(type)) { req.abort(); return; }

      if (
        sessionReady &&
        url.includes("groceries.morrisons.com/api/search") &&
        (url.includes("searchTerm=") || url.includes("entry=")) &&
        !url.includes("suggestions") &&
        !url.includes("redirects")
      ) {
        const newUrl = url
          .replace(/searchTerm=[^&]*/i, `searchTerm=${encodeURIComponent(query)}`)
          .replace(/entry=[^&]*/i, `entry=${encodeURIComponent(query)}`);

        const cookies = await page.cookies();
        const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join("; ");

        try {
          const res = await safeFetch(newUrl, {
            headers: {
              ...BROWSER_HEADERS,
              Accept: "application/json",
              Referer: "https://groceries.morrisons.com/",
              Cookie: cookieStr,
            },
          }, 12000);

          const json = await res.json();
          const items =
            json?.products ?? json?.data?.products ?? json?.items ??
            json?.results ?? json?.hits ?? json?.productItems ??
            (Array.isArray(json) ? json : []);

          for (const p of Array.isArray(items) ? items : []) {
            if (results.length >= 3) break;
            const name = p.name ?? p.title ?? p.displayName ?? p.product?.name ?? "";
            const price =
              p.price?.current ?? p.price?.value ?? p.pricePerItem ??
              p.retailPrice ?? (typeof p.price === "number" ? p.price : null);
            if (!name || price == null) continue;
            results.push({
              name: String(name).trim().slice(0, 120),
              price: `£${Number(price).toFixed(2)}`,
              unit: p.price?.perUnit ?? p.unitPrice ?? "",
              store: "Morrisons",
            });
          }
        } catch { /* ignore */ }

        clearTimeout(timeout);
        await page.close().catch(() => {});
        resolve(results);
        req.abort();
        return;
      }

      req.continue();
    });

    try {
      await page.goto("https://groceries.morrisons.com/", { waitUntil: "domcontentloaded", timeout: 20000 });
      await new Promise(r => setTimeout(r, 3000));
      sessionReady = true;

      await page.goto(
        `https://groceries.morrisons.com/search?entry=${encodeURIComponent(query)}`,
        { waitUntil: "domcontentloaded", timeout: 20000 }
      );
      await new Promise(r => setTimeout(r, 15000));

      if (results.length === 0) {
        clearTimeout(timeout);
        await page.close().catch(() => {});
        resolve([]);
      }
    } catch {
      clearTimeout(timeout);
      await page.close().catch(() => {});
      resolve([]);
    }
  });
}

// ---------------------------------------------------------------------------
// Streaming search endpoint — results arrive store by store via SSE
// ---------------------------------------------------------------------------
app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing ?q= parameter" });

  console.log(`\nSearching: "${query}"`);

  const settle = (promise, store) =>
    promise
      .then(r => { console.log(`  ✓ ${store}: ${r.length} result(s)`); return r; })
      .catch(err => { console.warn(`  ✗ ${store}:`, err.message); return []; });

  const [sainsburys, tesco, asda, morrisons] = await Promise.all([
    settle(searchSainsburys(query), "Sainsbury's"),
    settle(searchTesco(query), "Tesco"),
    settle(searchAsda(query), "ASDA"),
    settle(searchMorrisons(query), "Morrisons"),
  ]);

  const results = [...sainsburys, ...tesco, ...asda, ...morrisons];
  res.json({ query, results });
});
// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
app.listen(3000, async () => {
  console.log("Running on port 3000");
  try {
    await getBrowser();
    console.log("[puppeteer] Browser ready");

    Promise.all([
      getAsdaAlgoliaCredentials().then(c => {
        if (c) console.log(`[asda] credentials ready (app: ${c.appId}, index: ${c.indexName})`);
        else console.warn("[asda] credential warm-up failed");
      }),
      getTescoXapiTemplate().then(t => {
        if (t) console.log(`[tesco] xapi template ready: ${t.url.slice(0, 60)}`);
        else console.warn("[tesco] xapi template warm-up failed");
      }),
    ]);
  } catch (err) {
    console.warn("[puppeteer] Could not pre-launch:", err.message);
  }
});

process.on("exit", () => { if (browserInstance) browserInstance.close(); });
process.on("SIGINT", async () => {
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});