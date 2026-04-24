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
// Shared card scraper — Morrisons / Ocado
// ---------------------------------------------------------------------------
const BADGE_NOISE =
  /Featured\s*This is a featured product\.?\s*|Suitable for vegetarians?|Suitable for home freezing|Vegetarian|Vegan|Gluten Free|Organic|Ocado Price Promise|Morrisons Price Match|Price Match|Ordinarily[^(]+\([^)]+\)|LIFE \d+d\+[^(]+|Microwavable|Lactose Free|\(\d+\)\s*Rating[^.]+\.\s*/gi;

function scrapeProductCards($, storeName) {
  const results = [];
  $(".product-card-container").each((_, card) => {
    if (results.length >= 3) return;
    const price = $(card).find("span[class*='_display_xy0eg_1']").first().text().trim();
    if (!price) return;
    let name = "";
    $(card)
      .find("a[href*='/products/'], [class*='product-title'], [class*='productTitle'], h4, h3")
      .each((_, el) => {
        const t = $(el).clone().children().remove().end().text().trim();
        if (!name && t.length > 3 && t.length < 120) name = t;
      });
    if (!name) {
      const cleaned = $(card).text().replace(BADGE_NOISE, " ").replace(/\s+/g, " ").trim();
      name = cleaned.split(/£[\d.]/)[0].trim().slice(0, 100);
    }
    if (name) results.push({ name, price, unit: "", store: storeName });
  });
  return results;
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
      p.name ??
      p.display_name ??
      p.full_name ??
      p.product_info?.name ??
      p.base_product_info?.name ??
      "";
    const priceRaw =
      p.retail_price?.price ??
      p.price ??
      p.unit_price?.price ??
      p.current_retail_price ??
      p.prices?.price?.value ??
      null;

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
    `${SAINSBURYS_BASE}?search=${q}&page_size=9&store=${s}`,
    `https://www.sainsburys.co.uk/groceries-api/gol-services/product/v2/product?filter%5Bkeyword%5D=${q}&page_size=9&store=${s}`,
    `https://www.sainsburys.co.uk/groceries-api/gol-services/product/v2/product?keywords=${q}&page_size=9&store=${s}`,
  ];

  for (const url of endpoints) {
    try {
      const res = await safeFetch(url, { headers: GOL_API_HEADERS }, 10000);
      if (!res.ok) { console.log(`  [sainsburys] ${res.status} for ${url.split("?")[1]}`); continue; }
      const json = await res.json();
      const results = parseSainsburysProducts(json, query);
      if (results.length > 0) {
        console.log(`  [sainsburys] hit with param: ${new URL(url).searchParams.toString().slice(0, 60)}`);
        return results;
      } else {
        const total = (json?.products ?? json?.data?.products ?? json?.results ?? json?.data ?? []).length;
        console.log(`  [sainsburys] 200 but 0 matching products (${total} total) for param: ${new URL(url).searchParams.toString().slice(0, 60)}`);
      }
    } catch (e) { console.log(`  [sainsburys] error: ${e.message}`); }
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
    } catch (err) {
      clearTimeout(timeout);
      await page.close().catch(() => {});
      resolve([]);
    }
  });
}

async function searchSainsburys(query) {
  const direct = await searchSainsburysDirect(query);
  if (direct !== null) return direct;
  console.log("  [sainsburys] all direct attempts failed, falling back to Puppeteer…");
  return searchSainsburysPuppeteer(query);
}

// ---------------------------------------------------------------------------
// ASDA — Algolia, capturing credentials AND index name from warm-up request
// ---------------------------------------------------------------------------
let asdaAlgoliaCache = null; // { apiKey, appId, indexName }

async function getAsdaAlgoliaCredentials() {
  if (asdaAlgoliaCache) return asdaAlgoliaCache;

  console.log("  [asda] extracting Algolia credentials from network…");
  const page = await newPage();

  return new Promise(async (resolve) => {
    const timeout = setTimeout(async () => {
      await page.close().catch(() => {});
      console.warn("  [asda] credential extraction timed out");
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

        // Also extract indexName from the POST body
        let indexName = null;
        try {
          const body = req.postData();
          if (body) {
            const parsed = JSON.parse(body);
            indexName = parsed?.requests?.[0]?.indexName ?? null;
          }
        } catch { /* ignore parse errors */ }

        if (apiKey && appId) {
          asdaAlgoliaCache = { apiKey, appId, indexName };
          console.log(`  [asda] captured key ${apiKey.slice(0, 8)}… app ${appId} index ${indexName}`);
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
      await page.goto(
        "https://groceries.asda.com/search/milk",
        { waitUntil: "domcontentloaded", timeout: 20000 }
      );
      await new Promise(r => setTimeout(r, 8000));
    } catch { /* ignore nav errors */ }

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
  if (!creds) { console.warn("  [asda] no credentials available"); return []; }

  // Use captured index name, fall back to known candidates if null
  const indexName = creds.indexName ?? "prod_main";
  console.log(`  [asda] searching index: ${indexName}`);

  try {
    const json = await algoliaSearch(creds.appId, creds.apiKey, indexName, query);
    return hitsToAsda(json?.results?.[0]?.hits ?? []);
  } catch (err) {
    console.warn("  [asda] Algolia search failed:", err.message);
    asdaAlgoliaCache = null; // invalidate so next call re-extracts
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tesco — capture xapi GraphQL request via Puppeteer then replay directly
// Cache the request template (headers + operation) across searches
// ---------------------------------------------------------------------------
let tescoXapiCache = null; // { url, headers, operationTemplate }

async function getTescoXapiTemplate() {
  if (tescoXapiCache) return tescoXapiCache;

  console.log("  [tesco] capturing xapi request template…");
  const page = await newPage();

  return new Promise(async (resolve) => {
    const timeout = setTimeout(async () => {
      await page.close().catch(() => {});
      console.warn("  [tesco] xapi capture timed out");
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

        // Only cache the product search operation, not recommendations
        const hasSearch = Array.isArray(body)
          ? body.some(op => op?.operationName?.toLowerCase().includes("search") || op?.operationName?.toLowerCase().includes("product"))
          : body?.operationName?.toLowerCase().includes("search") || body?.operationName?.toLowerCase().includes("product");

        if (body && (hasSearch || Array.isArray(body))) {
          tescoXapiCache = { url, headers, body };
          console.log(`  [tesco] captured xapi template: ${url.slice(0, 80)}`);
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
  // Replace the query term inside the captured body template
  const str = JSON.stringify(body);
  // Variables object usually has { query: "milk" } — replace it
  const patched = str.replace(/"query"\s*:\s*"[^"]*"/g, `"query":"${query.replace(/"/g, '\\"')}"`);
  return JSON.parse(patched);
}

async function searchTesco(query) {
  const template = await getTescoXapiTemplate();
  if (!template) {
    console.warn("  [tesco] no xapi template, skipping");
    return [];
  }

  try {
    const patchedBody = patchTescoBody(template.body, query);
    // Strip headers that would cause issues (content-length, host)
    const { host, "content-length": _cl, ...safeHeaders } = template.headers;

    const res = await safeFetch(template.url, {
      method: "POST",
      headers: { ...safeHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(patchedBody),
    }, 15000);

    if (!res.ok) {
      console.warn(`  [tesco] xapi replay ${res.status} — invalidating cache`);
      tescoXapiCache = null;
      return [];
    }

    const json = await res.json();
    return parseTescoXapi(json);
  } catch (err) {
    console.warn("  [tesco] xapi replay error:", err.message);
    tescoXapiCache = null;
    return [];
  }
}

// ---------------------------------------------------------------------------
// Morrisons — capture real search API request via Puppeteer then replay
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Morrisons — needs a live session cookie before search works.
// Visit homepage first to get cookies, then navigate to search.
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

      // Once session is ready, intercept the search API call
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
        console.log(`  [morrisons] intercepted: ${newUrl.slice(0, 100)}`);

        // Get cookies from Puppeteer to replay with node-fetch
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
          console.log(`  [morrisons] keys: ${Object.keys(json).join(", ")}`);

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
        } catch (e) {
          console.log(`  [morrisons] fetch error: ${e.message}`);
        }

        clearTimeout(timeout);
        await page.close().catch(() => {});
        resolve(results);
        req.abort();
        return;
      }

      req.continue();
    });

    try {
      // Step 1: visit homepage to establish session cookies
      console.log("  [morrisons] establishing session…");
      await page.goto("https://groceries.morrisons.com/", {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
      await new Promise(r => setTimeout(r, 3000));
      sessionReady = true;

      // Step 2: navigate to search — JS should now fire the search XHR
      console.log("  [morrisons] navigating to search…");
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
    } catch (err) {
      clearTimeout(timeout);
      await page.close().catch(() => {});
      resolve([]);
    }
  });
}

// ---------------------------------------------------------------------------
// Ocado — window.__INITIAL_STATE__
// ---------------------------------------------------------------------------
async function searchOcado(query) {
  const url = `https://www.ocado.com/search?entry=${encodeURIComponent(query)}`;
  const res = await safeFetch(url, { headers: BROWSER_HEADERS });
  const html = await res.text();
  const $ = cheerio.load(html);

  let initialState = null;
  $("script:not([src])").each((_, el) => {
    if (initialState) return;
    const src = $(el).html() || "";
    if (!src.startsWith("window.__INITIAL_STATE__=")) return;
    try {
      initialState = JSON.parse(src.slice("window.__INITIAL_STATE__=".length).replace(/;$/, ""));
    } catch { /* fall through */ }
  });

  if (initialState) {
    const items =
      initialState?.data?.products?.items ??
      initialState?.data?.search?.products ??
      initialState?.search?.products ??
      initialState?.products?.items ??
      [];
    if (Array.isArray(items) && items.length > 0) {
      return items.slice(0, 3).map((p) => ({
        name: p.name ?? p.displayName ?? p.title ?? "Unknown",
        price: p.price != null ? `£${Number(p.price).toFixed(2)}` : "N/A",
        unit: p.catchWeight ?? p.unitOfMeasure ?? "",
        store: "Ocado",
      }));
    }
  }

  return scrapeProductCards($, "Ocado");
}

// ---------------------------------------------------------------------------
// Debug routes
// ---------------------------------------------------------------------------
app.get("/debug-api", async (req, res) => {
  const store = (req.query.store || "tesco").toLowerCase();
  const query = req.query.q || "milk";
  const page = await newPage();
  const captured = [];

  page.on("response", async (response) => {
    if (captured.length >= 15) return;
    const url = response.url();
    const ct = response.headers()["content-type"] || "";
    if (!ct.includes("json") && !ct.includes("javascript")) return;
    if (
      url.includes("analytics") || url.includes("telemetry") ||
      url.includes("boomerang") || url.includes("tracking") ||
      url.endsWith(".js") || url.includes("feature") || url.includes("flags")
    ) return;
    try {
      const text = await response.text();
      if (!text.includes("price") && !text.includes("product") && !text.includes("item")) return;
      let topLevelKeys = [];
      try { topLevelKeys = Object.keys(JSON.parse(text)); } catch { topLevelKeys = ["(not valid JSON)"]; }
      captured.push({ url, status: response.status(), contentType: ct, preview: text.slice(0, 800), topLevelKeys });
    } catch { /* skip */ }
  });

  const navUrls = {
    asda: `https://groceries.asda.com/search/${encodeURIComponent(query)}`,
    sainsburys: `https://www.sainsburys.co.uk/gol-ui/SearchDisplay?searchTerm=${encodeURIComponent(query)}&pageSize=9`,
    tesco: `https://www.tesco.com/groceries/en-GB/search?query=${encodeURIComponent(query)}&count=24`,
  };

  try {
    await page.goto(navUrls[store] ?? navUrls.tesco, { waitUntil: "domcontentloaded", timeout: 25000 });
    await new Promise(r => setTimeout(r, 10000));
  } catch { /* ignore */ }

  await page.close().catch(() => {});
  res.json({ store, query, capturedCount: captured.length, captured });
});

// Dump the raw HTML Puppeteer sees for Tesco or Morrisons
app.get("/debug-html", async (req, res) => {
  const store = (req.query.store || "tesco").toLowerCase();
  const query = req.query.q || "milk";
  const page = await newPage();

  const urls = {
    tesco: `https://www.tesco.com/groceries/en-GB/search?query=${encodeURIComponent(query)}&count=24`,
    morrisons: `https://groceries.morrisons.com/search?entry=${encodeURIComponent(query)}`,
  };

  let html = "";
  let finalUrl = "";
  let status = 0;

  try {
    const response = await page.goto(urls[store] ?? urls.tesco, {
      waitUntil: "domcontentloaded",
      timeout: 25000,
    });
    status = response?.status() ?? 0;
    finalUrl = page.url();
    await new Promise(r => setTimeout(r, 3000));
    html = await page.content();
  } catch (err) {
    html = `ERROR: ${err.message}`;
  }

  await page.close().catch(() => {});
  // Return first 4000 chars so it fits in the browser
  res.json({
    store, query, status, finalUrl,
    htmlLength: html.length,
    htmlPreview: html.slice(0, 4000),
  });
});

// Log every outgoing request on Morrisons - two step: homepage then search
app.get("/debug-morrisons-requests", async (req, res) => {
  const query = req.query.q || "milk";
  const page = await newPage();
  const captured = [];

  page.removeAllListeners("request");
  await page.setRequestInterception(true);

  page.on("request", (req) => {
    const url = req.url();
    const type = req.resourceType();
    if (["image", "font", "media"].includes(type)) { req.abort(); return; }
    if (!url.endsWith(".js") && !url.endsWith(".css") &&
        !url.includes("gtm") && !url.includes("onetrust") &&
        !url.includes("tradedoubler") && !url.includes("grafana")) {
      captured.push({ step: "?", method: req.method(), url, type });
    }
    req.continue();
  });

  try {
    // Step 1: homepage
    await page.goto("https://groceries.morrisons.com/", { waitUntil: "domcontentloaded", timeout: 20000 });
    captured.forEach(c => { if (!c.step || c.step === "?") c.step = "homepage"; });
    await new Promise(r => setTimeout(r, 4000));

    const beforeSearch = captured.length;

    // Step 2: search
    await page.goto(
      `https://groceries.morrisons.com/search?entry=${encodeURIComponent(query)}`,
      { waitUntil: "domcontentloaded", timeout: 20000 }
    );
    captured.slice(beforeSearch).forEach(c => { if (c.step === "?") c.step = "search"; });
    await new Promise(r => setTimeout(r, 10000));
    captured.slice(beforeSearch).forEach(c => { if (c.step === "?") c.step = "search"; });
  } catch (e) { /* ignore */ }

  await page.close().catch(() => {});
  res.json({ query, count: captured.length, requests: captured });
});

// Capture every JSON response on Morrisons search to find the right URL/shape
app.get("/debug-morrisons", async (req, res) => {
  const query = req.query.q || "milk";
  const page = await newPage();
  const captured = [];

  page.on("response", async (response) => {
    if (captured.length >= 20) return;
    const url = response.url();
    const ct = response.headers()["content-type"] || "";
    if (!ct.includes("json")) return;
    if (url.includes("analytics") || url.includes("gtm") || url.includes("cookie")) return;
    try {
      const text = await response.text();
      if (text.length < 50) return;
      let topLevelKeys = [];
      try { topLevelKeys = Object.keys(JSON.parse(text)); } catch { topLevelKeys = ["(not valid JSON)"]; }
      captured.push({ url, status: response.status(), preview: text.slice(0, 600), topLevelKeys });
    } catch { /* skip */ }
  });

  try {
    await page.goto(
      `https://groceries.morrisons.com/search?entry=${encodeURIComponent(query)}`,
      { waitUntil: "domcontentloaded", timeout: 25000 }
    );
    await new Promise(r => setTimeout(r, 10000));
  } catch { /* ignore */ }

  await page.close().catch(() => {});
  res.json({ query, capturedCount: captured.length, captured });
});

// Capture ASDA Algolia request body (index name + credentials)
app.get("/debug-asda-index", async (req, res) => {
  // Invalidate cache so we do a fresh capture
  asdaAlgoliaCache = null;
  const creds = await getAsdaAlgoliaCredentials();
  res.json(creds ?? { error: "No Algolia request captured" });
});

// ---------------------------------------------------------------------------
// Main search endpoint
// ---------------------------------------------------------------------------
app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing ?q= parameter" });

  console.log(`\nSearching: "${query}"`);

  const settle = (promise, store) =>
    promise
      .then((r) => { console.log(`  ✓ ${store}: ${r.length} result(s)`); return r; })
      .catch((err) => { console.warn(`  ✗ ${store}:`, err.message); return []; });

  const [sainsburys, tesco, asda, morrisons, ocado] = await Promise.all([
    settle(searchSainsburys(query), "Sainsbury's"),
    settle(searchTesco(query), "Tesco"),
    settle(searchAsda(query), "ASDA"),
    settle(searchMorrisons(query), "Morrisons"),
    settle(searchOcado(query), "Ocado"),
  ]);

  const all = [...sainsburys, ...tesco, ...asda, ...morrisons, ...ocado];
  console.log(`  → ${all.length} total results`);
  res.json({ query, results: all });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
app.listen(3000, async () => {
  console.log("Running on port 3000");
  try {
    await getBrowser();
    console.log("[puppeteer] Browser ready");

    // Warm up all Puppeteer-dependent credentials in parallel
    Promise.all([
      getAsdaAlgoliaCredentials().then(c => {
        if (c) console.log(`[asda] credentials ready (app: ${c.appId}, index: ${c.indexName})`);
        else console.warn("[asda] credential warm-up failed");
      }),
      getTescoXapiTemplate().then(t => {
        if (t) console.log(`[tesco] xapi template ready: ${t.url.slice(0, 60)}`);
        else console.warn("[tesco] xapi template warm-up failed — will retry on first search");
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