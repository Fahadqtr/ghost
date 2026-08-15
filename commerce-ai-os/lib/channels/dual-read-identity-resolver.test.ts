// CH.5 Phase D — dual-read resolver tests.
// node --conditions=react-server --experimental-strip-types --test lib/channels/dual-read-identity-resolver.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { createDualReadResolver, type DualReadMismatch } from "./dual-read-identity-resolver.ts";
import { type ExternalIdentityResolver, type StoreRef } from "../adapters/types.ts";

const store: StoreRef = { channel: "snoonu", storeId: "snoonu:malikas", storeKey: "snoonu:malikas", label: "x", listingGrain: "product" };

const stub = (id: string | null): ExternalIdentityResolver => ({
  resolve: async (s) => ({ storeKey: s.storeKey, externalListingId: id, source: id ? "products_column" : "none" }),
});

test("primary (ECL) is always returned, even when legacy disagrees", async () => {
  const r = createDualReadResolver(stub("ECL-A"), stub("LEGACY-B"));
  const ref = await r.resolve(store, { productId: "p1" });
  assert.equal(ref.externalListingId, "ECL-A"); // ECL wins; legacy never overrides
});

test("mismatch is reported (diagnostic), not healed", async () => {
  const seen: DualReadMismatch[] = [];
  const r = createDualReadResolver(stub("ECL-A"), stub("LEGACY-B"), { onMismatch: (m) => seen.push(m) });
  const ref = await r.resolve(store, { productId: "p1" });
  assert.equal(ref.externalListingId, "ECL-A");        // result unchanged
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].primaryExternalId, seen[0].fallbackExternalId], ["ECL-A", "LEGACY-B"]);
});

test("agreement → no mismatch", async () => {
  const seen: DualReadMismatch[] = [];
  const r = createDualReadResolver(stub("SAME"), stub("SAME"), { onMismatch: (m) => seen.push(m) });
  await r.resolve(store, { productId: "p1" });
  assert.equal(seen.length, 0);
});

test("a throwing fallback never affects the authoritative result", async () => {
  const throwing: ExternalIdentityResolver = { resolve: async () => { throw new Error("legacy down"); } };
  const r = createDualReadResolver(stub("ECL-A"), throwing, { onMismatch: () => { throw new Error("should not run"); } });
  const ref = await r.resolve(store, { productId: "p1" });
  assert.equal(ref.externalListingId, "ECL-A");
});
