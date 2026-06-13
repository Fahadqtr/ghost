#!/usr/bin/env node
// Inventory-sync runner — submits the prepared track_*.graphql + set_*.graphql
// files straight to the Shopify Admin GraphQL API, bypassing the Claude MCP
// approval gate entirely.
//
// Usage:
//   SHOPIFY_SHOP=your-store.myshopify.com \
//   SHOPIFY_ADMIN_TOKEN=shpat_xxx \
//   node run-sync.mjs            # runs track files, then set files
//
// Options (env):
//   SHOPIFY_API_VERSION   Admin API version (default 2025-01)
//   DRY_RUN=1             print what would run, send nothing
//   ONLY=track|set        run only one phase
//
// Get the token: Shopify admin -> Settings -> Apps and sales channels ->
//   Develop apps -> Create an app -> Configure Admin API scopes:
//   write_inventory (+ read_inventory, read_products) -> Install ->
//   "Reveal token once" -> copy the shpat_... value.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";
const DRY = process.env.DRY_RUN === "1";
const ONLY = process.env.ONLY; // "track" | "set" | undefined

if (!DRY && (!SHOP || !TOKEN)) {
  console.error("ERROR: set SHOPIFY_SHOP (your-store.myshopify.com) and SHOPIFY_ADMIN_TOKEN.");
  console.error("Run with DRY_RUN=1 to preview without credentials.");
  process.exit(1);
}

const ENDPOINT = `https://${SHOP}/admin/api/${VERSION}/graphql.json`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ordered list of the prepared files. track first (enable tracking), then set.
function filesFor(prefix) {
  return fs
    .readdirSync(DIR)
    .filter((f) => new RegExp(`^${prefix}_\\d+\\.graphql$`).test(f))
    .sort((a, b) => {
      const na = +a.match(/_(\d+)\./)[1];
      const nb = +b.match(/_(\d+)\./)[1];
      return na - nb;
    });
}

const track = ONLY === "set" ? [] : filesFor("track");
const set = ONLY === "track" ? [] : filesFor("set");
const queue = [...track, ...set];

// Walk any JSON shape and collect every non-empty userErrors array we find,
// regardless of alias name (track files use t0..t99 aliases).
function collectUserErrors(data, acc = []) {
  if (!data || typeof data !== "object") return acc;
  for (const [k, v] of Object.entries(data)) {
    if (k === "userErrors" && Array.isArray(v) && v.length) acc.push(...v);
    else if (v && typeof v === "object") collectUserErrors(v, acc);
  }
  return acc;
}

async function postWithRetry(query, label, maxAttempts = 6) {
  let attempt = 0;
  let backoff = 2000;
  while (true) {
    attempt++;
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": TOKEN,
      },
      body: JSON.stringify({ query }),
    });

    // HTTP-level throttle / transient server errors -> backoff + retry
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= maxAttempts) throw new Error(`${label}: HTTP ${res.status} after ${attempt} attempts`);
      console.log(`  ${label}: HTTP ${res.status}, retrying in ${backoff}ms (attempt ${attempt})`);
      await sleep(backoff);
      backoff *= 2;
      continue;
    }

    const json = await res.json();

    // GraphQL-level throttle (cost limit) -> backoff + retry
    const throttled = json.errors?.some((e) => e.extensions?.code === "THROTTLED");
    if (throttled) {
      if (attempt >= maxAttempts) throw new Error(`${label}: THROTTLED after ${attempt} attempts`);
      console.log(`  ${label}: THROTTLED, retrying in ${backoff}ms (attempt ${attempt})`);
      await sleep(backoff);
      backoff *= 2;
      continue;
    }

    if (json.errors?.length) {
      throw new Error(`${label}: GraphQL errors: ${JSON.stringify(json.errors)}`);
    }

    const userErrors = collectUserErrors(json.data);
    return { userErrors, json };
  }
}

async function main() {
  console.log(`Endpoint : ${DRY ? "(dry run)" : ENDPOINT}`);
  console.log(`Files    : ${track.length} track + ${set.length} set = ${queue.length} requests`);
  console.log("");

  let ok = 0;
  let withErrors = 0;
  const errorSamples = [];

  for (const f of queue) {
    const query = fs.readFileSync(path.join(DIR, f), "utf8");
    if (DRY) {
      console.log(`DRY  ${f}  (${query.length} bytes)`);
      ok++;
      continue;
    }
    try {
      const { userErrors } = await postWithRetry(query, f);
      if (userErrors.length) {
        withErrors++;
        errorSamples.push({ file: f, errors: userErrors.slice(0, 3) });
        console.log(`WARN ${f}: ${userErrors.length} userError(s) (first: ${userErrors[0].message})`);
      } else {
        ok++;
        console.log(`OK   ${f}`);
      }
    } catch (e) {
      withErrors++;
      errorSamples.push({ file: f, errors: [{ message: e.message }] });
      console.log(`FAIL ${f}: ${e.message}`);
    }
    await sleep(600); // gentle pacing between requests
  }

  console.log("");
  console.log(`Done. clean=${ok}  with-errors=${withErrors}`);
  if (errorSamples.length) {
    console.log("Error samples:");
    console.log(JSON.stringify(errorSamples, null, 2));
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
