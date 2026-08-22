import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const ROOT = process.cwd();
const read = (path: string) => readFileSync(`${ROOT}/${path}`, "utf8");

test("V2 quantities delegates to the existing inventory surface and authorities", () => {
  const v2 = read("app/(v2)/v2/inventory/page.tsx");
  const legacy = read("app/(app)/inventory/page.tsx");
  assert.match(v2, /@\/app\/\(app\)\/inventory\/page/);
  assert.match(legacy, /from\("inventory"\)/);
  assert.match(legacy, /product_variants/);
  assert.match(legacy, /isAvailable\(r\.stock_status\)/);
});

test("quantity and availability keep separate canonical write engines", () => {
  const actions = read("app/(app)/inventory/actions.ts");
  assert.match(actions, /setAbsolute\(admin, id, stock\)/);
  assert.match(actions, /setVariantAbsolute/);
  assert.match(actions, /setProductAvailabilityState/);
  assert.match(actions, /setVariantAvailabilityState/);
  assert.doesNotMatch(actions, /stock_quantity\s*:\s*inStock/);
});

test("both V2 and legacy inventory shells require an authenticated user", () => {
  for (const path of ["app/(v2)/v2/layout.tsx", "app/(app)/layout.tsx"]) {
    const layout = read(path);
    assert.match(layout, /auth\.getUser\(\)/);
    assert.match(layout, /if \(!user\) redirect\("\/login"\)/);
  }
});
