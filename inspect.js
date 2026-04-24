const cheerio = require("cheerio");
const fs = require("fs");

function inspectMorrisons() {
  const html = fs.readFileSync("morrisons_response.html", "utf8");
  const $ = cheerio.load(html);

  $("[class*='product-card']").slice(0, 3).each((i, card) => {
    console.log(`\n--- Card ${i + 1} ---`);
    console.log(`Class: "${$(card).attr("class")}"`);
    console.log(`Full text: "${$(card).text().trim().slice(0, 300)}"`);

    $(card).find("*").each((_, el) => {
      const cls = $(el).attr("class") || "";
      const text = $(el).clone().children().remove().end().text().trim();
      if (!text || text.length > 100) return;
      if (
        cls.includes("name") || cls.includes("title") || cls.includes("price") ||
        cls.includes("Name") || cls.includes("Title") || cls.includes("Price") ||
        text.match(/^£[\d.]/)
      ) {
        console.log(`  <${el.tagName}> class="${cls}" → "${text}"`);
      }
    });
  });
}

inspectMorrisons();