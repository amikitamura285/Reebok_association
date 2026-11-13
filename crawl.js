// Reebok公式オンラインショップ(reebok.jp)の商品を取得し、関連付け未対応の商品を site/products.json に書き出す。
// 実行: node crawl.js   (CRAWL_LIMIT=50 のように指定すると、試し実行できる)
const fs = require("node:fs/promises");
const path = require("node:path");

const BASE = "https://reebok.jp";
const SITEMAP = `${BASE}/sitemap_commodity.xml`;
const OUT_FILE = path.join(__dirname, "site", "products.json");
const CRAWL_LIMIT = Number(process.env.CRAWL_LIMIT || 0);
const CRAWL_CONCURRENCY = Number(process.env.CRAWL_CONCURRENCY || 8);
const headers = { "user-agent": process.env.CRAWLER_USER_AGENT || "ReebokFinder/1.0 (+internal product monitor)" };

function decodeHtml(value) {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

function stripTags(value) {
  return decodeHtml(value.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function englishKey(name) {
  return (name.match(/[A-Za-z][A-Za-z0-9'&+\-/ ]*/g) || []).join(" ")
    .replace(/[^A-Za-z0-9]+/g, " ").trim().toUpperCase();
}

function firstDigit(value) {
  return value.match(/\d/)?.[0] || "";
}

function displayGroupKey(product) {
  return `${product.englishKey}\u0000${product.brandItemFirstDigit || product.productNumber}`;
}

function firstMatch(html, expressions) {
  for (const expression of expressions) {
    const match = html.match(expression);
    if (match && match[1]) return stripTags(match[1]);
  }
  return "";
}

function parseJsonLd(html) {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const script of scripts) {
    try {
      const value = JSON.parse(script[1].trim());
      const candidates = Array.isArray(value) ? value : [value, ...(value["@graph"] || [])];
      const product = candidates.find((item) => item && (item["@type"] === "Product" || item.name));
      if (product) return product;
    } catch {
      // 壊れたJSON-LDがあっても、他の方法で取得を続ける
    }
  }
  return {};
}

function parseProduct(url, html) {
  const json = parseJsonLd(html);
  const brandCode = firstMatch(html, [/<input[^>]+id=["']brandCode["'][^>]+value=["']([^"']+)/i]);
  const brandName = firstMatch(html, [
    /<input[^>]+id=["']searchBrandName["'][^>]+value=["']([^"']+)/i,
    /<p[^>]+class=["']brandName["'][^>]*>([^<{]+)<\/p>/i
  ]).toUpperCase();
  const name = stripTags(String(json.name || firstMatch(html, [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i
  ])));
  const image = typeof json.image === "string" ? json.image : Array.isArray(json.image) ? json.image[0] : firstMatch(html, [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i
  ]);
  const productNumber = url.match(/\/commodity\/[^/]+\/([^/]+)\/?$/i)?.[1] || url.match(/\/([^/]+)\/?$/)?.[1] || "";
  const brandItemRow = html.match(/<tr[^>]*class=["'][^"']*-brandItemCode[^"']*["'][^>]*>([\s\S]*?)<\/tr>/i)?.[1] || "";
  const brandItemNumber = stripTags(brandItemRow.replace(/<th[\s\S]*?<\/th>/i, "")).trim();
  const relatedSections = [...html.matchAll(/<section[^>]*(?:id=["']related_product["']|related|recommend|おすすめ|関連)[^>]*>([\s\S]*?)<\/section>/gi)]
    .map((match) => match[1]);
  const relatedNames = relatedSections.flatMap((section) =>
    [...section.matchAll(/<img[^>]+alt=["']([^"']+)["']/gi)].map((match) => stripTags(match[1])));
  return {
    name, image, productNumber, brandItemNumber,
    brandItemFirstDigit: firstDigit(brandItemNumber),
    url, brandCode, brandName,
    englishKey: englishKey(name),
    relatedNames,
    variationProductNumbers: []
  };
}

async function fetchText(url, attempt = 0) {
  try {
    const response = await fetch(url, { headers, redirect: "follow" });
    if (!response.ok) {
      const error = new Error(`${response.status} ${response.statusText} (${url})`);
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    }
    return await response.text();
  } catch (error) {
    if (attempt < 2 && error.retryable !== false) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      return fetchText(url, attempt + 1);
    }
    throw error;
  }
}

// 色違い(同じ商品の別の色)は1つにまとめ、代表の1点だけを残す
function representativeProducts(products) {
  const parent = new Map();
  const find = (code) => {
    if (!parent.has(code)) parent.set(code, code);
    let root = code;
    while (parent.get(root) !== root) root = parent.get(root);
    let current = code;
    while (parent.get(current) !== root) {
      const next = parent.get(current);
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const product of products) {
    find(product.productNumber);
    for (const code of product.variationProductNumbers || []) union(product.productNumber, code);
  }
  const best = new Map();
  for (const product of products) {
    const root = find(product.productNumber);
    const current = best.get(root);
    if (!current || product.productNumber < current.productNumber) best.set(root, product);
  }
  const keep = new Set([...best.values()].map((product) => product.productNumber));
  return products.filter((product) => keep.has(product.productNumber));
}

async function fetchVariationProductNumbers(productNumber) {
  try {
    const response = JSON.parse(await fetchText(`${BASE}/commodity/${productNumber}/colors`));
    return (response.relatedCommodityStocks || []).map((item) => item.commodityCode).filter((code) => code && code !== productNumber);
  } catch (error) {
    console.warn(`Variation lookup failed for ${productNumber}: ${error.message}`);
    return [];
  }
}

async function mapConcurrent(values, worker, concurrency) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function consume() {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await worker(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, consume));
  return results;
}

async function readPrevious() {
  try {
    return JSON.parse((await fs.readFile(OUT_FILE, "utf8")).replace(/^﻿/, ""));
  } catch {
    return {};
  }
}

async function crawl() {
  const sitemap = await fetchText(SITEMAP);
  const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  const urls = CRAWL_LIMIT > 0 ? sitemapUrls.slice(0, CRAWL_LIMIT) : sitemapUrls;
  const previouslySeen = new Set((await readPrevious()).displayedMainProductNumbers || []);
  console.log(`取得対象: ${urls.length}件`);

  let done = 0;
  const products = (await mapConcurrent(urls, async (url) => {
    try {
      const product = parseProduct(url, await fetchText(url));
      product.variationProductNumbers = await fetchVariationProductNumbers(product.productNumber);
      const isReebok = product.brandCode === "RE1759" && product.brandName === "REEBOK";
      return product.name && product.englishKey && isReebok ? product : null;
    } catch (error) {
      console.warn(`Skipping ${url}: ${error.message}`);
      return null;
    } finally {
      if (++done % 200 === 0) console.log(`  ${done}/${urls.length}`);
    }
  }, CRAWL_CONCURRENCY)).filter(Boolean);

  const eligibleProducts = representativeProducts(products);
  const eligibleGroups = new Map();
  for (const product of eligibleProducts) {
    const key = displayGroupKey(product);
    if (!eligibleGroups.has(key)) eligibleGroups.set(key, []);
    eligibleGroups.get(key).push(product);
  }
  // 同じ英字名・同じ品番の頭の数字の商品が2件以上あり、関連アイテム欄に同名がない商品
  const matchedCandidates = eligibleProducts.filter((product) => {
    const sameName = eligibleGroups.get(displayGroupKey(product)) || [];
    const hasSameRelated = product.relatedNames.some((related) => englishKey(related) === product.englishKey);
    return sameName.length > 1 && !hasSameRelated;
  });
  const matchedGroups = new Map();
  for (const product of matchedCandidates) {
    const key = displayGroupKey(product);
    if (!matchedGroups.has(key)) matchedGroups.set(key, []);
    matchedGroups.get(key).push(product);
  }
  const matched = [...matchedGroups.entries()]
    .flatMap(([key, items]) => {
      const already = new Set(items.map((item) => item.productNumber));
      const linked = (eligibleGroups.get(key) || []).filter((item) => !already.has(item.productNumber));
      return [...items, ...linked];
    })
    .map(({ variationProductNumbers, ...product }) => product);

  const displayBuckets = new Map();
  for (const product of matched) {
    const key = displayGroupKey(product);
    if (!displayBuckets.has(key)) displayBuckets.set(key, []);
    displayBuckets.get(key).push(product);
  }
  const displayGroups = [...displayBuckets.values()].map((items) => {
    const newItems = items.filter((item) => !previouslySeen.has(item.productNumber));
    if (!newItems.length) return null;
    const main = newItems[0];
    return { englishKey: main.englishKey, main, related: items.filter((item) => item !== main) };
  }).filter(Boolean);

  const result = {
    updatedAt: new Date().toISOString(),
    products: matched,
    groups: displayGroups,
    newCount: displayGroups.length,
    displayedMainProductNumbers: [...new Set([...previouslySeen, ...displayGroups.map((g) => g.main.productNumber)])],
    scanned: products.length
  };
  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fs.writeFile(OUT_FILE, JSON.stringify(result, null, 2), "utf8");
  console.log(`完了: 走査${products.length}件 / 色違いまとめ後${eligibleProducts.length}件 / 表示${matched.length}件`);
}

crawl().catch((error) => { console.error(error); process.exit(1); });
