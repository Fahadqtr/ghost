#!/usr/bin/env node
// Description-fix runner — strips the Excel "_x000D_" carriage-return artifact
// from product descriptions by submitting productUpdate mutations straight to the
// Shopify Admin GraphQL API. Reads the prepared descfix.json (id + cleaned
// descriptionHtml), so there is no transcription step.
//
// Usage:
//   SHOPIFY_SHOP=516wu8-0g.myshopify.com \
//   SHOPIFY_ADMIN_TOKEN=shpat_xxx \
//   node run-descfix.mjs            # updates every product in descfix.json
//
// Options (env):
//   SHOPIFY_API_VERSION   Admin API version (default 2025-01)
//   DRY_RUN=1             print what would run, send nothing
//
// Token scope required: write_products (+ read_products).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";
const DRY = process.env.DRY_RUN === "1";

if (!DRY && (!SHOP || !TOKEN)) {
  console.error("ERROR: set SHOPIFY_SHOP and SHOPIFY_ADMIN_TOKEN (or DRY_RUN=1 to preview).");
  process.exit(1);
}

const ENDPOINT = `https://${SHOP}/admin/api/${VERSION}/graphql.json`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const items = JSON.parse(fs.readFileSync(path.join(DIR, "descfix.json"), "utf8"));

const MUTATION = `mutation($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id }
    userErrors { field message }
  }
}`;

async function postWithRetry(variables, label, maxAttempts = 6) {
  let attempt = 0;
  let backoff = 2000;
  while (true) {
    attempt++;
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query: MUTATION, variables }),
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= maxAttempts) throw new Error(`${label}: HTTP ${res.status} after ${attempt} attempts`);
      await sleep(backoff); backoff *= 2; continue;
    }
    const json = await res.json();
    const throttled = json.errors?.some((e) => e.extensions?.code === "THROTTLED");
    if (throttled) {
      if (attempt >= maxAttempts) throw new Error(`${label}: THROTTLED after ${attempt} attempts`);
      await sleep(backoff); backoff *= 2; continue;
    }
    if (json.errors?.length) throw new Error(`${label}: ${JSON.stringify(json.errors)}`);
    return json.data.productUpdate.userErrors || [];
  }
}

async function main() {
  console.log(`Endpoint : ${DRY ? "(dry run)" : ENDPOINT}`);
  console.log(`Products : ${items.length}`);
  console.log("");
  let ok = 0, withErrors = 0;
  const errorSamples = [];
  for (const it of items) {
    const label = it.id.replace("gid://shopify/Product/", "");
    if (DRY) { console.log(`DRY  ${label}  ${it.title}`); ok++; continue; }
    try {
      const userErrors = await postWithRetry({ product: { id: it.id, descriptionHtml: it.descriptionHtml } }, label);
      if (userErrors.length) {
        withErrors++; errorSamples.push({ id: label, errors: userErrors.slice(0, 2) });
        console.log(`WARN ${label}: ${userErrors[0].message}`);
      } else { ok++; console.log(`OK   ${label}  ${it.title}`); }
    } catch (e) {
      withErrors++; errorSamples.push({ id: label, errors: [{ message: e.message }] });
      console.log(`FAIL ${label}: ${e.message}`);
    }
    await sleep(400);
  }
  console.log("");
  console.log(`Done. clean=${ok}  with-errors=${withErrors}`);
  if (errorSamples.length) { console.log(JSON.stringify(errorSamples, null, 2)); process.exit(2); }
}

main().catch((e) => { console.error(e); process.exit(1); });
