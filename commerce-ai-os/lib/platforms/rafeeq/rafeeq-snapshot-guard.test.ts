// Phase UI.9.7 — safety scans for the Rafeeq snapshot adapter (source scans).
// Guards: pure adapter, EXACT channel resolution (no ilike), server-only READ-only
// capture/reader, no new client/webhook/cron, WRITE only to platform_snapshots
// (never products/channel_products/platform_status), no export-behavior change,
// owner-only action, no secret leakage, price/availability null, page/UI wiring.
// Run: node --experimental-strip-types --test lib/platforms/rafeeq/rafeeq-snapshot-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PURE = readFileSync(new URL("./capture-compute.ts", import.meta.url), "utf8");
const CAPTURE = readFileSync(new URL("./snapshot-capture.ts", import.meta.url), "utf8");
const READER = readFileSync(new URL("./snapshot-presence.ts", import.meta.url), "utf8");
const ACTION = readFileSync(new URL("../../../app/(app)/import-export/rafeeq-snapshot-actions.ts", import.meta.url), "utf8");
const PAGE = readFileSync(new URL("../../../app/(v2)/v2/operations/page.tsx", import.meta.url), "utf8");

/** Source with `import` lines removed, so ordering checks compare CALL SITES
 *  rather than the order the modules happen to be imported in. */
function bodyOnly(src: string): string {
  return src.replace(/^import .*$/gm, "");
}

const NO_WRITE = [".update(", ".delete(", ".rpc(", "createAdminClient", "service_role", "SERVICE_ROLE"];
const SECRET_TOKENS = ["access_token", "shpat_", "SERVICE_ROLE", "console.log"];

test("adapter is PURE — no server-only, no I/O, no clock", () => {
  assert.equal(PURE.includes('import "server-only"'), false);
  for (const bad of ["fetch(", "createClient", "process.env", "Date.now(", "new Date("]) {
    assert.equal(PURE.includes(bad), false, `pure adapter must not contain ${bad}`);
  }
});

test("channel resolution is EXACT — never ilike/%rafeeq%", () => {
  for (const src of [PURE, CAPTURE, READER]) {
    assert.equal(/ilike|%rafeeq%/i.test(src), false, "must resolve the channel by exact name, not ilike");
  }
});

test("capture is server-only and adds no Rafeeq client/api", () => {
  assert.ok(CAPTURE.includes('import "server-only"'));
  for (const bad of ["new Rafeeq", "createRafeeqClient", "fetch(", "/api/", "graphql"]) {
    assert.equal(CAPTURE.includes(bad), false, `capture must not add a Rafeeq client/api (${bad})`);
  }
});

test("capture + reader WRITE nothing but snapshots (INSERT-only, session client)", () => {
  for (const bad of NO_WRITE) {
    assert.equal(CAPTURE.includes(bad), false, `capture must not contain ${bad}`);
    assert.equal(READER.includes(bad), false, `reader must not contain ${bad}`);
  }
  assert.equal(READER.includes(".insert("), false, "reader is READ-only");
});

test("no writes to products / channel_products / platform_status", () => {
  for (const src of [CAPTURE, READER, ACTION]) {
    // Any of these tables followed (soon) by a mutation is forbidden.
    for (const table of ["products", "channel_products", "platform_status"]) {
      const re = new RegExp(`["']${table}["'][\\s\\S]{0,80}(insert|update|delete|upsert)\\(`, "i");
      assert.equal(re.test(src), false, `must not write ${table}`);
    }
    // platform_status must not be touched at all in the snapshot path.
    assert.equal(src.includes("platform_status"), false, "snapshot path must not read/write platform_status");
  }
});

test("no scheduler / event receiver is added (no cron/webhook code)", () => {
  for (const src of [PURE, CAPTURE, READER, ACTION]) {
    assert.equal(/setInterval\(|setTimeout\(|node-cron|CronJob|export async function (GET|POST)\b/.test(src), false);
  }
});

test("no secret / raw-error leakage in the snapshot path", () => {
  for (const src of [PURE, CAPTURE, READER, ACTION]) {
    for (const bad of SECRET_TOKENS) assert.equal(src.includes(bad), false, `must not contain ${bad}`);
  }
  assert.ok(CAPTURE.includes("تعذّر حفظ لقطات رفيق حاليًا."), "capture surfaces only a fixed Arabic message");
});

test("capture never records Rafeeq price or availability", () => {
  assert.ok(PURE.includes("price: null"));
  assert.ok(PURE.includes("availability: null"));
});

// ACC-02B batch 3 — the capture ACTION now builds the SERVICE-ROLE client. The
// old ban on createAdminClient here encoded "INSERT via the session client under
// RLS", but that RLS was an INSERT policy WITH CHECK (true) for every
// authenticated account — it authorized nothing beyond "is signed in".
// requireOwner() is the real boundary and still runs FIRST. The genuinely
// important bans (no UPDATE, no DELETE, no RPC, no embedded service-role KEY)
// are unchanged below.
const ACTION_NO_WRITE = [".update(", ".delete(", ".rpc(", "service_role", "SERVICE_ROLE"];

test("action is OWNER-only and INSERT-only via the SERVICE-ROLE client (ACC-02B b3)", () => {
  assert.ok(ACTION.includes('"use server"'));
  assert.ok(ACTION.includes("requireOwner"));
  assert.ok(ACTION.includes("createAdminClient"), "the insert runs on the service role");
  assert.equal(ACTION.includes("createClient()"), false, "no session client for the capture path");
  // requireOwner must precede the privileged client.
  {
    const body = bodyOnly(ACTION);
    assert.ok(body.indexOf("requireOwner(") < body.indexOf("createAdminClient("),
      "a denied call must never construct the service-role client");
  }
  for (const bad of ACTION_NO_WRITE) assert.equal(ACTION.includes(bad), false);
});

test("no new platform_snapshots table / migration is introduced", () => {
  for (const src of [PURE, CAPTURE, READER]) assert.equal(/create\s+table/i.test(src), false);
});

test("operations page wires the reader + best-effort, stale-gated auto-capture", () => {
  assert.ok(PAGE.includes("loadRafeeqSnapshotView"), "page reads Rafeeq snapshots");
  assert.ok(PAGE.includes("void captureRafeeqSnapshots"), "auto-capture is fire-and-forget");
  assert.ok(PAGE.includes("rafeeqStale") && PAGE.includes("rafeeqAvailable"), "auto-capture gated on freshness");
});
