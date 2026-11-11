// D-2 — CRM + Loyalty authorization proofs for the owner's STEP SYSTEM ACCESS 10
// policy:
//
//   STAFF  : MAY READ the customer/order info needed for customer service;
//            MAY NOT modify/delete customers, change points/balance, redeem
//            rewards, or touch prizes / loyalty configuration.
//   OWNER  : full CRM + Loyalty access.
//   ORDINARY SUPABASE USER : nothing, merely because a session exists.
//
// Two layers, as elsewhere in this repo:
//   1. BEHAVIOURAL — decideCrmAccess() and the minimizers are pure, so the
//      four-way distinction and the withheld-field set are EXECUTED here.
//   2. WIRING (source scan) — the actions import `server-only` and `@/…`, which
//      node:test cannot resolve, so gate-before-side-effect is proven by reading
//      the source. That ordering is what makes a denied call a ZERO privileged
//      DB call.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/crm/d2-crm-loyalty-access.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decideCrmAccess, isStaffViewer, CRM_ACCESS_DENIED } from "./access-check.ts";
import {
  minimizeCustomersForStaff, minimizeCountsForStaff, minimizeStatsForStaff, minimizeDetailForStaff,
  STAFF_WITHHELD_CUSTOMER_FIELDS, STAFF_WITHHELD_DETAIL_FIELDS,
} from "./staff-view.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const STAFF = { name: "سارة", id: "staff-1" };

// ---------------------------------------------------------------------------
// 1. BEHAVIOURAL — the four-way access decision
// ---------------------------------------------------------------------------

test("unauthenticated caller is DENIED", () => {
  const d = decideCrmAccess(false, null);
  assert.equal(d.viewer, undefined);
  assert.equal(d.error, CRM_ACCESS_DENIED);
});

test("ordinary Supabase authenticated non-owner is DENIED — a session alone buys nothing", () => {
  // This is the exact case D-2 closes: signed in, but neither owner nor staff.
  const d = decideCrmAccess(false, null);
  assert.equal(d.viewer, undefined);
  assert.equal(d.error, CRM_ACCESS_DENIED);
  // …and it is indistinguishable from the signed-out denial.
  assert.deepEqual(decideCrmAccess(false, undefined), d);
});

test("validated staff session is allowed, as a STAFF viewer", () => {
  const d = decideCrmAccess(false, STAFF);
  assert.equal(d.error, undefined);
  assert.deepEqual(d.viewer, { kind: "staff", name: "سارة", id: "staff-1" });
  assert.equal(isStaffViewer(d.viewer), true);
});

test("owner session is allowed, as an OWNER viewer (never minimized)", () => {
  const d = decideCrmAccess(true, null);
  assert.deepEqual(d.viewer, { kind: "owner" });
  assert.equal(isStaffViewer(d.viewer), false);
});

test("owner wins even when a staff cookie is also present", () => {
  assert.deepEqual(decideCrmAccess(true, STAFF).viewer, { kind: "owner" });
});

test("a malformed staff record fails closed", () => {
  for (const bad of [{ name: "", id: "x" }, { name: null as unknown as string, id: "x" }]) {
    const d = decideCrmAccess(false, bad);
    assert.equal(d.viewer, undefined, `${JSON.stringify(bad)} must not be accepted`);
    assert.equal(d.error, CRM_ACCESS_DENIED);
  }
});

test("denial text never names the owner, the staff member, or the missing credential", () => {
  assert.doesNotMatch(CRM_ACCESS_DENIED, /@/);
  for (const word of ["clanqtr", "owner", "staff", "cookie", "session"]) {
    assert.equal(CRM_ACCESS_DENIED.toLowerCase().includes(word), false);
  }
});

// ---------------------------------------------------------------------------
// 2. BEHAVIOURAL — data minimization for staff readers (§6)
// ---------------------------------------------------------------------------

const FULL_ROW = {
  source: "shopify", sourceId: "gid://1", name: "نورة", phone: "+974...", instagram: "", email: "n@example.test",
  orders: 7, spent: 4200, currency: "QAR", lastActivityAt: "2026-09-01T00:00:00Z",
  segment: "vip", needsHuman: false, channel: "", tags: ["vip", "complaint"], hasNote: true,
};

test("staff rows withhold every commercial and internal field", () => {
  const [row] = minimizeCustomersForStaff([FULL_ROW]);
  assert.equal(row.spent, 0);
  assert.equal(row.orders, 0);
  assert.equal(row.segment, "lead");
  assert.deepEqual(row.tags, []);
  assert.equal(row.hasNote, false);
  // Every field named as withheld must actually be neutralised.
  for (const f of STAFF_WITHHELD_CUSTOMER_FIELDS) {
    const v = (row as Record<string, unknown>)[f];
    assert.ok(v === 0 || v === false || v === "lead" || (Array.isArray(v) && v.length === 0),
      `${f} must be blanked for a staff reader, got ${JSON.stringify(v)}`);
  }
});

test("staff rows KEEP exactly the customer-service fields", () => {
  const [row] = minimizeCustomersForStaff([FULL_ROW]);
  assert.equal(row.name, "نورة");
  assert.equal(row.phone, "+974...");
  assert.equal(row.email, "n@example.test");
  assert.equal(row.lastActivityAt, "2026-09-01T00:00:00Z");
  assert.equal(row.sourceId, "gid://1");
  assert.equal(row.needsHuman, false);
});

test("minimization does not mutate the owner's rows in place", () => {
  const original = { ...FULL_ROW };
  minimizeCustomersForStaff([FULL_ROW]);
  assert.deepEqual(FULL_ROW, original, "the source row must be untouched");
});

test("staff never receive the commercial breakdown or the business totals", () => {
  const counts = minimizeCountsForStaff({ vip: 3, repeat: 9, new: 4, lapsed: 2, lead: 40 });
  for (const [k, v] of Object.entries(counts)) assert.equal(v, 0, `${k} must be zeroed`);
  const EMPTY = { buyers: 0, leads: 0, revenue: 0, orders: 0, avgOrder: 0, currency: "QAR", top: [] };
  const stats = minimizeStatsForStaff(EMPTY);
  assert.equal(stats.revenue, 0);
  assert.deepEqual(stats.top, [], "top spenders are never exposed to staff");
});

test("staff detail drops the internal note and tags, keeps orders and messages", () => {
  const detail = {
    notes: "لا ترد عليها بسرعة", tags: ["صعبة"],
    orders: [{ name: "#1042", createdAt: "2026-08-01", fulfillment: "FULFILLED", total: 220, currency: "QAR" }],
    messages: [{ direction: "in", body: "وين طلبي؟", ai: false, created_at: "2026-09-01" }],
  };
  const out = minimizeDetailForStaff(detail);
  assert.equal(out.notes, "");
  assert.deepEqual(out.tags, []);
  assert.equal(out.orders?.length, 1, "order history is customer-service data — kept");
  assert.equal(out.messages?.length, 1, "the DM thread is customer-service data — kept");
  for (const f of STAFF_WITHHELD_DETAIL_FIELDS) {
    const v = (out as Record<string, unknown>)[f];
    assert.ok(v === "" || (Array.isArray(v) && v.length === 0), `${f} must be withheld`);
  }
});

// ---------------------------------------------------------------------------
// 3. WIRING — gate before any privileged call
// ---------------------------------------------------------------------------

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}
function fnBody(src: string, name: string): string {
  const code = stripComments(src);
  const start = code.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  const rest = code.slice(start + 1);
  const next = rest.indexOf("\nexport ");
  return next === -1 ? code.slice(start) : code.slice(start, start + 1 + next);
}

const CRM = read("app/(app)/crm/actions.ts");
const LOYALTY = read("app/(v2)/v2/loyalty/actions.ts");

/** Tokens that begin a privileged query, mutation or external customer call. */
const PRIVILEGED = [
  "admin(", "createAdminClient(", "sb.from", ".from(", ".upsert(", ".storage",
  "fetchShopifyCustomers(", "fetchShopifyCustomerOrders(", "upsertCustomer(",
  "approveSubmission(", "rejectSubmission(", "redeemReward(", "updateCustomer(",
  "deleteCustomer(", "addPrize(", "setPrizeActive(", "deletePrize(", "sendVoucherWhatsApp(",
];

function assertGateFirst(src: string, name: string, gate: string) {
  const body = fnBody(src, name);
  const at = body.indexOf(gate);
  assert.notEqual(at, -1, `${name} must call ${gate}`);
  for (const tok of PRIVILEGED) {
    const hit = body.indexOf(tok);
    if (hit !== -1) assert.ok(at < hit, `${name}: ${gate} must precede the first "${tok}"`);
  }
  assert.doesNotMatch(body, /requireUser\(\)/, `${name} must not fall back to requireUser()`);
  assert.doesNotMatch(body, /isSignedIn\(\)/, `${name} must not fall back to isSignedIn()`);
}

test("CRM reads: owner-or-staff gate runs before any privileged query", () => {
  assert.match(CRM, /import \{ requireCrmReader \} from "@\/lib\/auth\/crmAccess"/);
  for (const fn of ["listCustomers", "getCustomerDetail"]) {
    assertGateFirst(CRM, fn, "requireCrmReader()");
    // …and the staff branch must be decided from the gate, not from a client input.
    assert.match(fnBody(CRM, fn), /isStaffViewer\(gate\.viewer\)/,
      `${fn} must derive the staff flag from the gate result`);
  }
});

test("CRM writes: OWNER ONLY, gate before the customer upsert", () => {
  for (const fn of ["saveCustomerNote", "setCustomerTags"]) {
    assertGateFirst(CRM, fn, "requireOwnerGate()");
    assert.doesNotMatch(fnBody(CRM, fn), /requireCrmReader/,
      `${fn} must NOT accept a staff session — staff may not modify customers`);
  }
});

test("CRM: no action accepts a bare Supabase session any more", () => {
  const code = stripComments(CRM);
  assert.doesNotMatch(code, /await requireUser\(\)/);
  assert.doesNotMatch(code, /isSignedIn\(\)/);
  // Exactly two readers and exactly two owner-only writers — a new action fails this.
  assert.equal((code.match(/requireCrmReader\(\)/g) ?? []).length, 2);
  assert.equal((code.match(/requireOwnerGate\(\)/g) ?? []).length, 2);
  assert.equal((code.match(/^export async function /gm) ?? []).length, 4);
});

test("LOYALTY: every action is OWNER-ONLY — no staff, no bare session", () => {
  const code = stripComments(LOYALTY);
  assert.doesNotMatch(code, /requireUser/, "the local session-only gate must be gone");
  assert.doesNotMatch(code, /isSignedIn|requireCrmReader|currentStaff/,
    "no staff credential may grant loyalty access in this step");
  const exported = (code.match(/^export async function (\w+)/gm) ?? [])
    .map((m) => m.replace("export async function ", ""));
  assert.deepEqual(exported.sort(), [
    "addPrizeAction", "approveAction", "deleteCustomerAction", "deletePrizeAction",
    "redeemAction", "rejectAction", "sendVoucherAction", "setPrizeActiveAction",
    "updateCustomerAction",
  ], "the set of loyalty actions changed — re-check the gate on any new one");
  for (const fn of exported) {
    const body = fnBody(LOYALTY, fn);
    assert.match(body, /requireOwnerOrThrow\(\)|requireOwner\(\)/, `${fn} must be owner-gated`);
  }
});

test("LOYALTY: the destructive and balance-changing actions are gated before the helper runs", () => {
  for (const fn of ["deleteCustomerAction", "updateCustomerAction", "redeemAction", "deletePrizeAction", "setPrizeActiveAction", "addPrizeAction"]) {
    const body = fnBody(LOYALTY, fn);
    const at = Math.max(body.indexOf("requireOwnerOrThrow()"), body.indexOf("requireOwner()"));
    assert.ok(at !== -1, `${fn} must have an owner gate`);
    for (const tok of PRIVILEGED) {
      const hit = body.indexOf(tok);
      if (hit !== -1) assert.ok(at < hit, `${fn}: the gate must precede "${tok}" — a denied call must write nothing`);
    }
  }
});

test("LOYALTY: the void-returning actions THROW on denial, so a denial can't read as success", () => {
  const code = stripComments(LOYALTY);
  assert.match(code, /async function requireOwnerOrThrow\(\)[\s\S]*?throw new Error\(owner\.error\)/);
  // addPrizeAction returns { error } instead — its caller renders the string.
  assert.match(fnBody(LOYALTY, "addPrizeAction"), /if \(!owner\.ok\) return \{ error: owner\.error \}/);
});

test("LOYALTY bulk customer export is OWNER-ONLY, gated before the PII read", () => {
  const EXPORT = read("app/api/loyalty/customers/export/route.ts");
  const code = stripComments(EXPORT);
  assert.match(code, /import \{ requireOwner \} from "@\/lib\/malak\/authz"/);
  assert.doesNotMatch(code, /auth\.getUser\(\)|isSignedIn|requireUser/,
    "a bare Supabase session must not download the whole customer list");
  const guard = code.indexOf("requireOwner()");
  const rows = code.indexOf("await listCustomers()");
  assert.ok(guard !== -1 && guard < rows, "the gate must precede the customer read");
  // The denial carries the gate's own 401/403 rather than a flat 401.
  assert.match(code, /new Response\(owner\.error, \{ status: owner\.status \}\)/);
});

// ---------------------------------------------------------------------------
// 4. The staff gate itself is a real credential, not a client claim
// ---------------------------------------------------------------------------

test("staff gate: HMAC-verified, timing-safe, expiring, with live permission re-read", () => {
  const SESSION = read("lib/staff/session.ts");
  assert.match(SESSION, /createHmac\("sha256"/);
  assert.match(SESSION, /crypto\.timingSafeEqual/);
  assert.match(SESSION, /Date\.now\(\) - obj\.ts > maxAgeMs/);
  const CURRENT = read("lib/staff/current.ts");
  assert.match(CURRENT, /verifyStaff\(c\.get\(STAFF_COOKIE\)\?\.value\)/);
  assert.match(CURRENT, /if \(!s\) return null/);
  assert.match(CURRENT, /from\("staff_members"\)[\s\S]*?permissions, active/);
  assert.match(CURRENT, /if \(row\.active === false\) return null/);
});

test("the staff gate is NOT exported as a server action", () => {
  // app/staff/actions.ts is \"use server\": every export there is a public
  // endpoint, so the gate must live in lib/ and not be re-exported as a value.
  const STAFF_ACTIONS = read("app/staff/actions.ts");
  assert.doesNotMatch(STAFF_ACTIONS, /export (async function|const) currentStaff/);
  assert.match(STAFF_ACTIONS, /import \{ currentStaff, type CurrentStaff \} from "@\/lib\/staff\/current"/);
});
