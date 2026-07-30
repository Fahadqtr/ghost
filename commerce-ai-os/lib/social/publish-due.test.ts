// Tests for the scheduled-social publisher core. The decision/orchestration
// logic (selectDuePosts / publishDuePosts) runs with MOCKED deps — no network,
// no real Instagram/Meta/TikTok. Cron schedule, auth ordering, owner-only retry,
// and no-token logging are verified by scanning sources (the route + action
// import `server-only`, so node:test can't import them directly).
// Run: node --conditions=react-server --experimental-strip-types --test lib/social/publish-due.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  isDue,
  selectDuePosts,
  publishDuePosts,
  classifyPublishFailure,
  logPublishFailure,
  SAFE_PUBLISH_FAILURE_MESSAGE,
  PUBLISH_LIMIT,
  type SchedulablePost,
  type PublishDueDeps,
} from "./publish-due.ts";

const NOW = "2026-07-30T12:00:00.000Z";

function post(over: Partial<SchedulablePost> & { id: string }): SchedulablePost {
  return {
    platform: "instagram", caption: "c", image_url: "https://x/y.jpg",
    status: "pending", approved: true, scheduled_at: "2026-07-30T11:00:00.000Z", extras: null,
    ...over,
  };
}

// ---- 2/3/6/12: isDue --------------------------------------------------------

test("2/3: due only when approved + pending + scheduled_at <= now", () => {
  assert.equal(isDue(post({ id: "a", scheduled_at: "2026-07-30T11:59:59.000Z" }), NOW), true);
  assert.equal(isDue(post({ id: "b", scheduled_at: "2026-07-30T12:00:00.000Z" }), NOW), true); // exactly now
  assert.equal(isDue(post({ id: "c", scheduled_at: "2026-07-30T12:00:01.000Z" }), NOW), false); // future
});

test("6: a non-pending row is never due (published/publishing/failed/dismissed)", () => {
  for (const status of ["posted", "publishing", "failed", "dismissed"]) {
    assert.equal(isDue(post({ id: "x", status, scheduled_at: "2020-01-01T00:00:00Z" }), NOW), false, status);
  }
});

test("unapproved or unscheduled rows are never due", () => {
  assert.equal(isDue(post({ id: "u", approved: false }), NOW), false);
  assert.equal(isDue(post({ id: "n", scheduled_at: null }), NOW), false);
});

test("12: comparison is UTC/epoch and survives a midnight + day-change boundary", () => {
  // 00:05 UTC on the 31st is due at 00:10 UTC; 00:15 is not yet.
  const nowMidnight = "2026-07-31T00:10:00.000Z";
  assert.equal(isDue(post({ id: "m1", scheduled_at: "2026-07-31T00:05:00.000Z" }), nowMidnight), true);
  assert.equal(isDue(post({ id: "m2", scheduled_at: "2026-07-31T00:15:00.000Z" }), nowMidnight), false);
  // Same instant expressed with a +03:00 (Qatar) offset must compare identically
  // to its Z form — proving epoch compare, not string/local-tz compare.
  // 2026-07-31T03:05:00+03:00 === 2026-07-31T00:05:00Z (due at 00:10Z).
  assert.equal(isDue(post({ id: "m3", scheduled_at: "2026-07-31T03:05:00+03:00" }), nowMidnight), true);
  assert.equal(isDue(post({ id: "m4", scheduled_at: "2026-07-31T03:15:00+03:00" }), nowMidnight), false);
});

// ---- 4/5: selectDuePosts ordering + limit ------------------------------------

test("4: due posts are ordered oldest-scheduled first", () => {
  const rows = [
    post({ id: "late", scheduled_at: "2026-07-30T11:50:00Z" }),
    post({ id: "early", scheduled_at: "2026-07-30T09:00:00Z" }),
    post({ id: "mid", scheduled_at: "2026-07-30T10:30:00Z" }),
  ];
  assert.deepEqual(selectDuePosts(rows, NOW).map((p) => p.id), ["early", "mid", "late"]);
});

test("5: no more than the limit is selected, and only due ones", () => {
  const rows = [
    post({ id: "1", scheduled_at: "2026-07-30T08:00:00Z" }),
    post({ id: "2", scheduled_at: "2026-07-30T09:00:00Z" }),
    post({ id: "3", scheduled_at: "2026-07-30T10:00:00Z" }),
    post({ id: "4", scheduled_at: "2026-07-30T11:00:00Z" }),
    post({ id: "future", scheduled_at: "2026-07-30T23:00:00Z" }),
  ];
  assert.equal(PUBLISH_LIMIT, 3);
  assert.deepEqual(selectDuePosts(rows, NOW).map((p) => p.id), ["1", "2", "3"]);
});

// ---- orchestrator deps harness ----------------------------------------------

interface Trace { seq: string[]; claimed: string[]; published: string[]; posted: string[]; failed: { id: string; msg: string }[]; warns: string[]; }
function mkDeps(
  candidates: SchedulablePost[],
  over: { claim?: (id: string) => boolean; publish?: (p: SchedulablePost) => { ok: boolean; mediaId?: string | null; storyMirrored?: boolean; rawError?: string | null }; limit?: number } = {},
): { deps: PublishDueDeps; t: Trace } {
  const t: Trace = { seq: [], claimed: [], published: [], posted: [], failed: [], warns: [] };
  const deps: PublishDueDeps = {
    nowIso: NOW,
    limit: over.limit,
    fetchCandidates: async () => candidates,
    claim: async (id) => { t.seq.push(`claim:${id}`); const ok = over.claim ? over.claim(id) : true; if (ok) t.claimed.push(id); return ok; },
    publish: async (p) => { t.seq.push(`publish:${p.id}`); t.published.push(p.id); return over.publish ? over.publish(p) : { ok: true, mediaId: `m-${p.id}` }; },
    markPosted: async (id) => { t.seq.push(`posted:${id}`); t.posted.push(id); },
    markFailed: async (id, msg) => { t.seq.push(`failed:${id}`); t.failed.push({ id, msg }); },
    warn: (l) => t.warns.push(l),
  };
  return { deps, t };
}

// ---- 2: not-due is never published ------------------------------------------

test("2: a future post is never published", async () => {
  const { deps, t } = mkDeps([post({ id: "future", scheduled_at: "2026-07-30T23:00:00Z" })]);
  const out = await publishDuePosts(deps);
  assert.equal(out.published, 0);
  assert.equal(t.published.length, 0);
  assert.equal(t.claimed.length, 0, "a non-due post is never even claimed");
});

// ---- 7: claim happens BEFORE the external publish ---------------------------

test("7: each row is claimed before its external publish call", async () => {
  const { deps, t } = mkDeps([post({ id: "a" })]);
  await publishDuePosts(deps);
  assert.deepEqual(t.seq, ["claim:a", "publish:a", "posted:a"]);
});

// ---- 8: concurrency — a lost claim means no publish -------------------------

test("8: when the claim is lost (another run won), the post is NOT published", async () => {
  const { deps, t } = mkDeps([post({ id: "a" })], { claim: () => false });
  const out = await publishDuePosts(deps);
  assert.equal(out.published, 0);
  assert.equal(t.published.length, 0, "no external call after a lost claim");
  assert.equal(t.posted.length, 0);
  assert.equal(t.failed.length, 0);
  assert.equal(out.results[0].status, "not_claimed");
});

// ---- 9: success → posted ----------------------------------------------------

test("9: a successful publish marks the row posted with its media id", async () => {
  const { deps, t } = mkDeps([post({ id: "a" })], { publish: () => ({ ok: true, mediaId: "IG123", storyMirrored: true }) });
  const out = await publishDuePosts(deps);
  assert.equal(out.published, 1);
  assert.deepEqual(t.posted, ["a"]);
  assert.equal(t.failed.length, 0);
});

// ---- 10: failure → failed with a GENERIC message; raw never stored ----------

test("10: a failed publish marks failed with the safe generic message (no raw error)", async () => {
  const raw = "Meta 401 invalid token abcdef https://signed.example/media.jpg?sig=SECRET";
  const { deps, t } = mkDeps([post({ id: "a" })], { publish: () => ({ ok: false, rawError: raw }) });
  const out = await publishDuePosts(deps);
  assert.equal(out.published, 0);
  assert.equal(t.failed.length, 1);
  assert.equal(t.failed[0].msg, SAFE_PUBLISH_FAILURE_MESSAGE);
  assert.doesNotMatch(t.failed[0].msg, /token|401|https?:|SECRET/i, "stored message must carry no raw error/token/url");
  // The one warn line carries only the classified category — no raw text.
  assert.equal(t.warns.length, 1);
  assert.equal(t.warns[0], "[publish-social] fail platform=instagram kind=post reason=auth");
});

// ---- 5 (orchestrator): limit is respected end-to-end ------------------------

test("5: at most the limit is published even when more are due", async () => {
  const rows = Array.from({ length: 6 }, (_, i) =>
    post({ id: `p${i}`, scheduled_at: `2026-07-30T0${i}:00:00Z` }));
  const { deps, t } = mkDeps(rows);
  const out = await publishDuePosts(deps);
  assert.equal(out.published, PUBLISH_LIMIT);
  assert.equal(t.published.length, PUBLISH_LIMIT);
  assert.deepEqual(t.published, ["p0", "p1", "p2"]); // oldest first, capped
});

test("non-instagram due rows are skipped, never claimed", async () => {
  const { deps, t } = mkDeps([post({ id: "tk", platform: "tiktok" })]);
  const out = await publishDuePosts(deps);
  assert.equal(out.results[0].status, "skipped");
  assert.equal(t.claimed.length, 0);
  assert.equal(t.published.length, 0);
});

// ---- classifier + safe log --------------------------------------------------

test("classifyPublishFailure buckets by keyword and never returns raw", () => {
  assert.equal(classifyPublishFailure("HTTP 401 invalid oauth token"), "auth");
  assert.equal(classifyPublishFailure("429 rate limit exceeded"), "rate_limit");
  assert.equal(classifyPublishFailure("request timed out"), "timeout");
  assert.equal(classifyPublishFailure("unsupported media format"), "media");
  assert.equal(classifyPublishFailure("something odd"), "unknown");
  assert.equal(classifyPublishFailure(null), "unknown");
});

test("13: logPublishFailure emits only scope/platform/kind/category — no secrets", () => {
  const lines: string[] = [];
  logPublishFailure((l) => lines.push(l), { platform: "instagram", kind: "reel", category: "auth" });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[publish-social\] fail platform=instagram kind=reel reason=auth$/);
  for (const secret of ["token", "Bearer", "Authorization", "http", "sig="]) {
    assert.equal(lines[0].includes(secret), false, `log must not contain ${secret}`);
  }
});

// ---- source-scan: cron schedule, auth ordering, owner-only, no-token --------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

test("1: the publish path is checked every 15 minutes via Supabase pg_cron", () => {
  // The Vercel Hobby plan rejects sub-daily crons, so the 15-minute cadence is
  // driven by Supabase pg_cron (the mechanism the repo already ships), and
  // vercel.json keeps a single valid DAILY entry as a safety-net fallback.
  const pgcron = read("supabase/social_publish_cron.sql");
  assert.match(pgcron, /cron\.schedule\(\s*'publish-social',\s*'\*\/15 \* \* \* \*'/, "pg_cron runs the publish endpoint every 15 minutes");
  assert.match(pgcron, /\/api\/cron\/publish-social/, "pg_cron targets the publish endpoint");

  const vercel = JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] };
  const entries = vercel.crons.filter((c) => c.path === "/api/cron/publish-social");
  assert.equal(entries.length, 1, "exactly one Vercel cron for the publish path (no duplicate)");
  // Hobby-compatible: a once-daily schedule (minute + hour fixed, not a step).
  assert.match(entries[0].schedule, /^\d+ \d+ \* \* \*$/, "Vercel fallback must be a valid once-daily schedule");
});

test("11: the cron rejects a bad CRON_SECRET before any DB or external work", () => {
  const route = read("app/api/cron/publish-social/route.ts");
  const auth = route.indexOf("CRON_SECRET");
  const unauthorized = route.indexOf('"unauthorized"');
  const admin = route.indexOf("createAdminClient(");
  const run = route.indexOf("publishDuePosts(");
  assert.ok(auth !== -1 && unauthorized !== -1, "auth check present");
  assert.ok(auth < admin, "secret is checked before the admin client is created");
  assert.ok(unauthorized < admin && unauthorized < run, "401 returns before DB/external work");
  // CRON_SECRET verification mechanism unchanged (Bearer scheme).
  assert.match(route, /Bearer \$\{secret\}/);
});

test("route claims (pending → publishing) before any external publish call", () => {
  const route = read("app/api/cron/publish-social/route.ts");
  // The claim CAS filters on the current status = pending.
  assert.match(route, /update\(\{ status: "publishing" \}\)[\s\S]*\.eq\("status", "pending"\)/);
});

test("14: manual publish + retry stays owner-only", () => {
  const actions = read("app/(app)/social/actions.ts");
  const at = actions.indexOf("export async function publishSocialPost");
  assert.notEqual(at, -1);
  const body = actions.slice(at, actions.indexOf("\nexport ", at + 1));
  assert.match(body, /requireOwner\(\)/, "publishSocialPost must remain owner-gated");
  assert.doesNotMatch(body, /isSignedIn\(\)/, "manual publish must not fall back to a signed-in-only guard");
});

test("13 (module): the publish-due core does no I/O and cannot leak tokens/urls", () => {
  const src = read("lib/social/publish-due.ts");
  // Strip comments so explanatory prose ("never a token/Authorization header")
  // doesn't count — we care that the CODE performs no I/O and no logging of its
  // own (it only calls the injected `warn` with a fixed, category-only line).
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  for (const forbidden of ["console.", "process.env", "fetch(", "https://", "http://"]) {
    assert.equal(code.includes(forbidden), false, `core must not use ${forbidden}`);
  }
});
