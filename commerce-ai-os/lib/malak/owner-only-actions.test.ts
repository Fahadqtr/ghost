// Wiring guarantees for the OWNER-ONLY gate: every server action / API route
// that publishes or messages externally must call requireOwner() BEFORE any DB
// write, Meta/Instagram/TikTok/WhatsApp request, or credit-spending AI job — so
// the protection cannot be bypassed by invoking the action/route directly, and
// hiding a button is never the only defense. Ordinary reads must stay on the
// lighter session guard (not silently escalated or downgraded).
//
// This is a source-scan test (the actions import `server-only` and `@/…`
// modules that node:test can't resolve), matching the repo's existing
// route/action-wiring test style.
// Run: node --conditions=react-server --experimental-strip-types --test lib/malak/owner-only-actions.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const SOCIAL = read("app/(app)/social/actions.ts");
const INBOX = read("app/(app)/inbox/actions.ts");
const LOYALTY = read("app/(v2)/v2/loyalty/actions.ts");
const IG_TEST_PUBLISH = read("app/api/social/ig-test-publish/route.ts");
const IG_VERIFY = read("app/api/social/ig-verify/route.ts");
const AUTHZ = read("lib/malak/authz.ts");

/** Slice a single `export async function NAME(` body up to the next top-level export. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  const rest = src.slice(start + 1);
  const next = rest.indexOf("\nexport ");
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
}

/** Tokens that begin a DB write or an external side effect — the guard must precede all of them. */
const SIDE_EFFECT = [
  "admin(", "adminClient(", "sb.from", ".from(",
  "publishToInstagram", "publishStoryToInstagram", "publishVideoStoryToInstagram",
  "publishReelToInstagram", "publishToTikTok", "sendInstagramDm", "connectDmChannel",
  "insertDmMessage", "sendVoucherWhatsApp", "verifyIgSetup", "generateScheduledPost",
];

function assertGuardedFirst(src: string, name: string) {
  const body = fnBody(src, name);
  const guard = body.indexOf("requireOwner");
  assert.notEqual(guard, -1, `${name} must call requireOwner()`);
  // The guard's result must be checked (denial short-circuits before any effect).
  assert.match(body, /const owner = await requireOwner\(\);\s*\n\s*if \(!owner\.ok\)/,
    `${name} must await requireOwner() and return on !owner.ok before doing work`);
  for (const tok of SIDE_EFFECT) {
    const at = body.indexOf(tok);
    if (at !== -1) {
      assert.ok(guard < at, `${name}: requireOwner() must come before first "${tok}"`);
    }
  }
  // A gated action must NOT still rely on the weaker "signed-in only" guard.
  assert.doesNotMatch(body, /isSignedIn\(\)/, `${name} must not fall back to isSignedIn()`);
  assert.doesNotMatch(body, /"Not signed in\."/, `${name} must not use the old signed-in-only denial`);
}

// ---- sensitive SOCIAL actions are owner-gated, guard-first --------------------

const SOCIAL_OWNER_ONLY = [
  "publishSocialPost", "publishReelByUrl", "publishStoryByUrl",
  "scheduleStory", "planWeekSlot", "approveSocialPost", "rescheduleSocialPost",
];

test("social: import + every sensitive publish/schedule action is owner-gated before side effects", () => {
  assert.match(SOCIAL, /import \{ requireOwner \} from "@\/lib\/malak\/authz"/);
  for (const fn of SOCIAL_OWNER_ONLY) assertGuardedFirst(SOCIAL, fn);
});

test("social: ordinary reads + draft-only tools are NOT escalated to owner-only", () => {
  // Reads / draft generators stay on the lighter signed-in guard — not blocked.
  for (const fn of ["listSocialPosts", "generateNowAction", "fetchSocialInsights"]) {
    const body = fnBody(SOCIAL, fn);
    assert.doesNotMatch(body, /requireOwner/, `${fn} must remain a non-owner path`);
    assert.match(body, /isSignedIn\(\)/, `${fn} must still require a signed-in session`);
  }
});

// ---- sensitive INBOX actions are owner-gated ---------------------------------

test("inbox: import + DM send / auto-reply / channel-connect are owner-gated first", () => {
  assert.match(INBOX, /import \{ requireOwner \} from "@\/lib\/malak\/authz"/);
  for (const fn of ["sendDmReply", "toggleDmAuto", "connectDmSubscription"]) {
    assertGuardedFirst(INBOX, fn);
  }
});

test("inbox: reading conversations/threads stays on the lighter session guard", () => {
  for (const fn of ["listDmConversations", "dmThread", "dmMetrics", "dmNeedsHumanCount", "resolveDmHuman"]) {
    const body = fnBody(INBOX, fn);
    assert.doesNotMatch(body, /requireOwner/, `${fn} must remain a non-owner read/triage path`);
    assert.match(body, /requireUser\(\)/, `${fn} must still require a signed-in session`);
  }
});

// ---- customer WhatsApp voucher send is owner-gated ---------------------------

test("loyalty: sendVoucherAction (WhatsApp to a customer) is owner-gated before the send", () => {
  assert.match(LOYALTY, /import \{ requireOwner \} from "@\/lib\/malak\/authz"/);
  assertGuardedFirst(LOYALTY, "sendVoucherAction");
});

// ---- the real-publish API routes are owner-gated ----------------------------

test("ig-test-publish route: owner-gated, no signed-in-only fallback, guard before publish", () => {
  assert.match(IG_TEST_PUBLISH, /import \{ requireOwner \} from "@\/lib\/malak\/authz"/);
  assert.doesNotMatch(IG_TEST_PUBLISH, /requireUser/);
  const guard = IG_TEST_PUBLISH.indexOf("requireOwner");
  const pub = IG_TEST_PUBLISH.indexOf("await publishToInstagram");
  const reel = IG_TEST_PUBLISH.indexOf("await publishReelToInstagram");
  assert.ok(guard !== -1 && guard < pub && guard < reel, "requireOwner must precede any publish call");
  assert.match(IG_TEST_PUBLISH, /if \(!owner\.ok\) return Response\.json\(\{ error: owner\.error \}, \{ status: owner\.status \}\)/);
});

test("ig-verify route: owner-gated, no signed-in-only fallback, guard before container creation", () => {
  assert.match(IG_VERIFY, /import \{ requireOwner \} from "@\/lib\/malak\/authz"/);
  assert.doesNotMatch(IG_VERIFY, /requireUser/);
  const guard = IG_VERIFY.indexOf("requireOwner");
  const verify = IG_VERIFY.indexOf("await verifyIgSetup");
  assert.ok(guard !== -1 && guard < verify, "requireOwner must precede verifyIgSetup()");
});

// ---- the central guard is strict (owner only, not the writer allow-list) -----

test("authz: requireOwner uses the pure decider and MALAK_WRITER_EMAILS does NOT widen it", () => {
  const body = fnBody(AUTHZ, "requireOwner");
  assert.match(body, /decideOwner\(/, "requireOwner must delegate to the pure decideOwner");
  assert.doesNotMatch(body, /writerSet|MALAK_WRITER/, "owner gate must not consult the writer allow-list");
});
