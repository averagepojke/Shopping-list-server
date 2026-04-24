// debug.js — run with: node debug.js
// Paste this file into your grocery-proxy folder and run it to diagnose
// what Sainsbury's, Tesco, and Ocado are actually returning.

const fetch = require("node-fetch");
const cheerio = require("cheerio");
const fs = require("fs");

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
  "Accept-Encoding": "identity", // disable compression so we can read the raw text
  Connection: "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
};

async function diagnose(storeName, url, extraHeaders = {}) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`DIAGNOSING: ${storeName}`);
  console.log(`URL: ${url}`);
  console.log("=".repeat(60));

  try {
    const res = await fetch(url, {
      headers: { ...BROWSER_HEADERS, ...extraHeaders },
    });

    const text = await res.text();
    console.log(`Status: ${res.status} ${res.statusText}`);
    console.log(`Content-Type: ${res.headers.get("content-type")}`);
    console.log(`Response length: ${text.length} chars`);

    // Is it HTML or JSON?
    const isHtml = text.trimStart().startsWith("<");
    const isJson = text.trimStart().startsWith("{") || text.trimStart().startsWith("[");
    console.log(`Format: ${isHtml ? "HTML" : isJson ? "JSON" : "Unknown"}`);

    if (isJson) {
      console.log("\n--- JSON preview (first 800 chars) ---");
      console.log(text.slice(0, 800));
    } else if (isHtml) {
      const $ = cheerio.load(text);

      // Check for __NEXT_DATA__
      const nextDataRaw = $("#__NEXT_DATA__").html();
      if (nextDataRaw) {
        console.log("\n✓ __NEXT_DATA__ found! Preview (first 600 chars):");
        console.log(nextDataRaw.slice(0, 600));
      } else {
        console.log("\n✗ No __NEXT_DATA__ found");
      }

      // Check for JSON-LD
      const jsonLds = [];
      $('script[type="application/ld+json"]').each((_, el) => {
        jsonLds.push($(el).html()?.slice(0, 200));
      });
      if (jsonLds.length > 0) {
        console.log(`\n✓ Found ${jsonLds.length} JSON-LD block(s). First one:`);
        console.log(jsonLds[0]);
      } else {
        console.log("\n✗ No JSON-LD found");
      }

      // Check for product-like elements
      const selectors = [
        ".pt-grid-item",
        "[data-testid='product-tile']",
        "[data-auto='product-tile']",
        ".product-list--list-item",
        "[class*='ProductTile']",
        "[class*='product-tile']",
        ".fops-item",
        "[class*='product-card']",
      ];
      console.log("\n--- Product element search ---");
      for (const sel of selectors) {
        const count = $(sel).length;
        if (count > 0) console.log(`  ✓ "${sel}" → ${count} element(s)`);
      }

      // Check for bot/challenge pages
      const title = $("title").text();
      const bodySnippet = $("body").text().trim().slice(0, 200);
      console.log(`\nPage title: "${title}"`);
      console.log(`Body snippet: "${bodySnippet}"`);

      // Save HTML to file for manual inspection
      const filename = `${storeName.toLowerCase().replace(/[^a-z]/g, "_")}_response.html`;
      fs.writeFileSync(filename, text);
      console.log(`\nFull HTML saved to: ${filename}`);
    }
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
  }
}

async function main() {
  await diagnose(
    "ASDA",
    "https://groceries.asda.com/search/milk"
  );

  await diagnose(
    "Morrisons",
    "https://groceries.morrisons.com/search?entry=milk"
  );
}

main();