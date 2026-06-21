import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Regenerates track_*.graphql and set_*.graphql from the local towrite.json.
// Run:  node gen.mjs
const DIR = path.dirname(fileURLToPath(import.meta.url));
const LOC = "gid://shopify/Location/81908531438";
const P = "gid://shopify/InventoryItem/";

const { set50 } = JSON.parse(fs.readFileSync(path.join(DIR, "towrite.json"), "utf8"));
const ids = set50;

function chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

// Remove any previously generated files so stale higher-index files can't linger.
for (const f of fs.readdirSync(DIR)) {
  if (/^(track|set)_\d+\.graphql$/.test(f)) fs.unlinkSync(path.join(DIR, f));
}

// Tracking: aliased inventoryItemUpdate. Batch of 50 keeps calculated cost
// (~10-11 pts/mutation) well under the 1000-pt single-query max on the
// standard Shopify plan. (100/batch sat at/over that limit -> hard failure.)
const TRACK_BATCH = 50;
const tc = chunk(ids, TRACK_BATCH);
tc.forEach((c, i) => {
  let m = "mutation {\n";
  c.forEach((id, j) => { m += `  t${j}: inventoryItemUpdate(id: "${P}${id}", input: {tracked: true}) { inventoryItem { id } userErrors { field message } }\n`; });
  m += "}";
  fs.writeFileSync(path.join(DIR, `track_${i}.graphql`), m);
});

// Set available=50. One inventorySetQuantities per file; the quantities input
// list is an argument (not part of query cost) and 250 is Shopify's per-call max.
const SET_BATCH = 250;
const sc = chunk(ids, SET_BATCH);
sc.forEach((c, i) => {
  const q = c.map((id) => `{inventoryItemId: "${P}${id}", locationId: "${LOC}", quantity: 50}`).join("\n      ");
  const m = `mutation {\n  inventorySetQuantities(input: {name: "available", reason: "correction", ignoreCompareQuantity: true, quantities: [\n      ${q}\n  ]}) {\n    inventoryAdjustmentGroup { changes { delta } }\n    userErrors { field message }\n  }\n}`;
  fs.writeFileSync(path.join(DIR, `set_${i}.graphql`), m);
});

console.log("ids:", ids.length, "| track files:", tc.length, `(${TRACK_BATCH} each)`, "| set files:", sc.length, `(${SET_BATCH} each)`);
console.log("track sizes:", tc.map((c) => c.length).join(","));
console.log("set sizes:", sc.map((c) => c.length).join(","));
