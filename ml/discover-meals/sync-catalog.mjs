import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config();

const root = process.cwd();
const cacheDir = path.join(root, ".cache");
const backupRoot = path.join(cacheDir, "backups");
const tmpDir = path.join(cacheDir, "tmp");
const catalogPath = path.join(cacheDir, "catalog-local-dev.json");
const discoverModelPath = path.join(cacheDir, "discover-meals-model.json");
const discoverEmbeddingsPath = path.join(cacheDir, "discover-meals-embeddings.json");
const catalogEmbeddingsPath = path.join(cacheDir, "catalog-embeddings-local-dev.json");

const PROD_BASE_URL = "https://api.zelo-epicerie.ch";
const AUTO_FETCH = "availableOptions,defaultSupplier";
const SENTINELS = [
  { key: "pain_balance", label: "Pain Balance", pattern: /\bpain\s+balance\b/i },
  { key: "beurre_frais", label: "Beurre frais", pattern: /\bbeurre\s+frais\b/i },
  { key: "lard", label: "Lard", pattern: /\blard\b/i },
  { key: "oeuf", label: "Oeuf", pattern: /\boeufs?\b/i },
];

function hasArg(name) {
  return process.argv.includes(name);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
}

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function productsFromCatalog(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const key of ["products", "items", "data"]) {
      if (Array.isArray(data[key])) return data[key];
    }
  }
  return [];
}

function productId(product) {
  return String(product?.id ?? product?._id ?? "").trim();
}

function productName(product) {
  return String(product?.name ?? "").trim();
}

function productHasPrice(product, country) {
  if (product?.price && typeof product.price === "object") {
    const directPrice = Number(product.price.price ?? product.price.discount);
    if (Number.isFinite(directPrice)) return true;
  }
  const countryPrice = product?.countryPrices?.[country];
  if (countryPrice && typeof countryPrice === "object") {
    const value = Number(countryPrice.price ?? countryPrice.discount);
    if (Number.isFinite(value)) return true;
  }
  return false;
}

function catalogSignature(products) {
  const payload = products.map((product) => ({
    id: productId(product),
    name: productName(product),
    updated: product?._updatedAt ?? "",
    categories: product?.categories ?? [],
  })).sort((left, right) => left.id.localeCompare(right.id));
  return sha1(JSON.stringify(payload));
}

function summarizeProducts(products, country) {
  const names = new Map();
  const duplicateNames = [];
  const sentinels = {};

  for (const sentinel of SENTINELS) {
    sentinels[sentinel.key] = {
      label: sentinel.label,
      found: false,
      matches: [],
    };
  }

  let withId = 0;
  let withName = 0;
  let withPrice = 0;
  let withCategories = 0;
  let withOptions = 0;

  for (const product of products) {
    const id = productId(product);
    const name = productName(product);
    if (id) withId += 1;
    if (name) withName += 1;
    if (productHasPrice(product, country)) withPrice += 1;
    if (Array.isArray(product?.categories) && product.categories.length > 0) withCategories += 1;
    if (Array.isArray(product?.availableOptions) && product.availableOptions.length > 0) withOptions += 1;

    const normalizedName = name.toLowerCase();
    if (normalizedName) {
      if (names.has(normalizedName)) duplicateNames.push(name);
      names.set(normalizedName, true);
    }

    for (const sentinel of SENTINELS) {
      if (sentinel.pattern.test(name)) {
        sentinels[sentinel.key].found = true;
        if (sentinels[sentinel.key].matches.length < 5) {
          sentinels[sentinel.key].matches.push({ id, name });
        }
      }
    }
  }

  return {
    count: products.length,
    withId,
    withName,
    withPrice,
    withCategories,
    withOptions,
    missingId: products.length - withId,
    missingName: products.length - withName,
    missingPrice: products.length - withPrice,
    missingCategories: products.length - withCategories,
    duplicateNames: duplicateNames.slice(0, 20),
    duplicateNameCount: duplicateNames.length,
    sentinelFoundCount: Object.values(sentinels).filter((entry) => entry.found).length,
    sentinels,
    signature: catalogSignature(products),
  };
}

function diffProducts(oldProducts, newProducts) {
  const oldById = new Map(oldProducts.map((product) => [productId(product), product]).filter(([id]) => id));
  const newById = new Map(newProducts.map((product) => [productId(product), product]).filter(([id]) => id));
  const added = [];
  const removed = [];
  const renamed = [];

  for (const [id, product] of newById) {
    if (!oldById.has(id)) {
      added.push({ id, name: productName(product) });
      continue;
    }
    const oldName = productName(oldById.get(id));
    const newName = productName(product);
    if (oldName && newName && oldName !== newName) renamed.push({ id, oldName, newName });
  }

  for (const [id, product] of oldById) {
    if (!newById.has(id)) removed.push({ id, name: productName(product) });
  }

  return {
    addedCount: added.length,
    removedCount: removed.length,
    renamedCount: renamed.length,
    added: added.slice(0, 50),
    removed: removed.slice(0, 50),
    renamed: renamed.slice(0, 50),
  };
}

function validateCatalog({ baseUrl, oldStats, newStats, force }) {
  const failures = [];
  const warnings = [];

  if (baseUrl !== PROD_BASE_URL) failures.push(`baseUrl must be ${PROD_BASE_URL}, got ${baseUrl}`);
  if (newStats.count <= 0) failures.push("new catalog is empty");
  if (newStats.count < 100) failures.push(`new catalog count is implausibly low: ${newStats.count}`);
  if (oldStats.count > 0 && newStats.count < oldStats.count * 0.75) {
    failures.push(`new catalog dropped by more than 25%: ${oldStats.count} -> ${newStats.count}`);
  }
  if (newStats.missingId > 0) failures.push(`new catalog has products without id: ${newStats.missingId}`);
  if (newStats.count > 0 && newStats.withName / newStats.count < 0.98) {
    failures.push(`too many products without name: ${newStats.missingName}/${newStats.count}`);
  }
  if (newStats.count > 0 && newStats.withPrice / newStats.count < 0.85) {
    failures.push(`too many products without price: ${newStats.missingPrice}/${newStats.count}`);
  }
  if (newStats.count > 0 && newStats.withCategories / newStats.count < 0.7) {
    failures.push(`too many products without categories: ${newStats.missingCategories}/${newStats.count}`);
  }
  if (newStats.sentinelFoundCount < 3) {
    failures.push(`too many sentinel products missing: found ${newStats.sentinelFoundCount}/${SENTINELS.length}`);
  }
  if (newStats.duplicateNameCount > 10) {
    warnings.push(`duplicate names found: ${newStats.duplicateNameCount}`);
  }

  return {
    ok: force ? true : failures.length === 0,
    forced: force && failures.length > 0,
    failures,
    warnings,
  };
}

async function fileManifest(filePath) {
  try {
    const raw = await fs.readFile(filePath);
    const parsed = JSON.parse(raw.toString("utf-8"));
    const products = productsFromCatalog(parsed);
    return {
      file: path.relative(root, filePath),
      exists: true,
      bytes: raw.length,
      sha1: sha1(raw),
      catalogCount: products.length || parsed?.model?.catalog?.count || null,
      catalogSignature: parsed?.model?.catalog?.signature || (products.length ? catalogSignature(products) : null),
      builtAt: parsed?.builtAt || parsed?.model?.trainedAt || null,
    };
  } catch {
    return {
      file: path.relative(root, filePath),
      exists: false,
    };
  }
}

async function backupDiscoverFiles(oldProducts, oldStats) {
  const stamp = timestamp();
  const backupDir = path.join(backupRoot, `discover-sync-${stamp}`);
  await fs.mkdir(backupDir, { recursive: true });

  const files = [
    catalogPath,
    discoverModelPath,
    discoverEmbeddingsPath,
    catalogEmbeddingsPath,
  ];
  const manifestFiles = [];

  for (const filePath of files) {
    const info = await fileManifest(filePath);
    manifestFiles.push(info);
    if (info.exists) {
      await fs.copyFile(filePath, path.join(backupDir, path.basename(filePath)));
    }
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    reason: "discover catalog sync backup before overwriting catalog-local-dev.json",
    oldCatalog: {
      count: oldProducts.length,
      stats: oldStats,
    },
    files: manifestFiles,
  };

  await fs.writeFile(path.join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  return backupDir;
}

async function fetchProductionCatalog({ apiKey, shopId, country }) {
  const url = new URL(`/shop/${shopId}/product`, PROD_BASE_URL);
  url.searchParams.set("country", country);
  url.searchParams.set("autoFetch", AUTO_FETCH);
  url.searchParams.set("apiKey", apiKey);

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Swissdata catalog fetch failed ${response.status}: ${body.slice(0, 400)}`);
  }

  const data = await response.json();
  const products = productsFromCatalog(data);
  return {
    products,
    publicUrl: `${PROD_BASE_URL}/shop/${shopId}/product?country=${country}&autoFetch=${AUTO_FETCH}`,
  };
}

async function writeReport(report) {
  await fs.mkdir(tmpDir, { recursive: true });
  const reportPath = path.join(tmpDir, `discover-catalog-sync-report-${timestamp()}.json`);
  const latestPath = path.join(tmpDir, "discover-catalog-sync-latest.json");
  const raw = JSON.stringify(report, null, 2);
  await fs.writeFile(reportPath, raw, "utf-8");
  await fs.writeFile(latestPath, raw, "utf-8");
  return reportPath;
}

function printSummary(report) {
  console.log(`[discover-catalog-sync] mode=${report.mode}`);
  console.log(`[discover-catalog-sync] source=${report.source.publicUrl}`);
  console.log(`[discover-catalog-sync] old count=${report.oldCatalog.stats.count} signature=${report.oldCatalog.stats.signature}`);
  console.log(`[discover-catalog-sync] new count=${report.newCatalog.stats.count} signature=${report.newCatalog.stats.signature}`);
  console.log(
    `[discover-catalog-sync] diff added=${report.diff.addedCount} removed=${report.diff.removedCount} renamed=${report.diff.renamedCount}`
  );
  console.log(
    `[discover-catalog-sync] completeness id=${report.newCatalog.stats.withId}/${report.newCatalog.stats.count} name=${report.newCatalog.stats.withName}/${report.newCatalog.stats.count} price=${report.newCatalog.stats.withPrice}/${report.newCatalog.stats.count} categories=${report.newCatalog.stats.withCategories}/${report.newCatalog.stats.count}`
  );
  console.log(
    `[discover-catalog-sync] sentinels=${report.newCatalog.stats.sentinelFoundCount}/${SENTINELS.length}`
  );
  if (report.validation.warnings.length) {
    console.warn(`[discover-catalog-sync] warnings: ${report.validation.warnings.join("; ")}`);
  }
  if (report.validation.failures.length) {
    console.error(`[discover-catalog-sync] failures: ${report.validation.failures.join("; ")}`);
  }
  if (report.backupDir) console.log(`[discover-catalog-sync] backup=${report.backupDir}`);
  console.log(`[discover-catalog-sync] report=${report.reportPath}`);
}

async function main() {
  const apply = hasArg("--apply");
  const dryRun = hasArg("--dry-run") || !apply;
  const force = hasArg("--force");
  const apiKey = process.env.SWISSDATA_API_KEY || process.env.APIKEY || "";
  const shopId = process.env.SWISSDATA_SHOP_ID || process.env.SHOPID || "";
  const country = process.env.SWISSDATA_COUNTRY || "CHE";

  if (!apiKey) throw new Error("Missing SWISSDATA_API_KEY/APIKEY in env");
  if (!shopId) throw new Error("Missing SWISSDATA_SHOP_ID/SHOPID in env");

  const oldCatalog = await readJson(catalogPath, {});
  const oldProducts = productsFromCatalog(oldCatalog);
  const oldStats = summarizeProducts(oldProducts, country);

  const fetched = await fetchProductionCatalog({ apiKey, shopId, country });
  const newProducts = fetched.products.map((product) => ({
    ...product,
    id: productId(product) || product.id,
  }));
  const newStats = summarizeProducts(newProducts, country);
  const diff = diffProducts(oldProducts, newProducts);
  const validation = validateCatalog({
    baseUrl: PROD_BASE_URL,
    oldStats,
    newStats,
    force,
  });

  let backupDir = null;
  let wroteCatalog = false;

  const report = {
    generatedAt: new Date().toISOString(),
    mode: dryRun ? "dry-run" : "apply",
    source: {
      baseUrl: PROD_BASE_URL,
      shopId,
      country,
      autoFetch: AUTO_FETCH,
      publicUrl: fetched.publicUrl,
    },
    oldCatalog: {
      path: path.relative(root, catalogPath),
      stats: oldStats,
    },
    newCatalog: {
      stats: newStats,
    },
    diff,
    validation,
    backupDir,
    wroteCatalog,
  };

  const reportPath = await writeReport(report);
  report.reportPath = path.relative(root, reportPath);

  if (!validation.ok) {
    printSummary(report);
    process.exitCode = 1;
    return;
  }

  if (apply) {
    backupDir = await backupDiscoverFiles(oldProducts, oldStats);
    const nextCatalog = {
      userRef: "production-sync",
      builtAt: new Date().toISOString(),
      source: report.source,
      stats: newStats,
      diff,
      products: newProducts,
    };
    await fs.writeFile(catalogPath, JSON.stringify(nextCatalog, null, 2), "utf-8");
    wroteCatalog = true;
    report.backupDir = path.relative(root, backupDir);
    report.wroteCatalog = true;
    const finalReportPath = await writeReport(report);
    report.reportPath = path.relative(root, finalReportPath);
  }

  printSummary(report);
}

main().catch((error) => {
  console.error("[discover-catalog-sync] ERROR", error?.message || error);
  process.exitCode = 1;
});
