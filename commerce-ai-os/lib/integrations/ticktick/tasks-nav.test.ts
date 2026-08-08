// /v2/tasks single-task redirect tests. PURE — no db/network/clock.
// Run: node --conditions=react-server --experimental-strip-types --test lib/integrations/ticktick/tasks-nav.test.ts
//
// These pin the FIX for the "معاينة TickTick does nothing" bug: the preview/sync
// redirect must carry the owner's current view (filter/search/page) AND target
// the previewed task, so the result box lands on the same card that was clicked.

import test from "node:test";
import assert from "node:assert/strict";

import { tasksRedirect } from "./tasks-nav.ts";

test("preview: preserves the current view (filter+page) and targets the clicked task", () => {
  const url = tasksRedirect("filter=needs_image&page=2", { ttplan: "needs_image:p9", pa: "create" });
  const qs = new URLSearchParams(url.split("?")[1]);
  // the previewed task id round-trips → the page renders the box on THAT card
  assert.equal(qs.get("ttplan"), "needs_image:p9");
  assert.equal(qs.get("pa"), "create");
  // and the owner stays on the same filtered page (previously dropped → bug)
  assert.equal(qs.get("filter"), "needs_image");
  assert.equal(qs.get("page"), "2");
});

test("preview: carries the search query so a searched view still shows the result", () => {
  const url = tasksRedirect("query=1234567890123&filter=all", { ttplan: "t1", pa: "update" });
  const qs = new URLSearchParams(url.split("?")[1]);
  assert.equal(qs.get("query"), "1234567890123");
  assert.equal(qs.get("ttplan"), "t1");
  assert.equal(qs.get("pa"), "update");
});

test("default view (no filter/search/page) → a clean redirect with only the result", () => {
  const url = tasksRedirect("", { ttplan: "t1", pa: "create" });
  assert.equal(url, "/v2/tasks?ttplan=t1&pa=create");
});

test("status banners (denied / not_configured / errors) also keep the view", () => {
  for (const code of ["denied", "not_configured", "notfound", "preview_error", "task_ok", "task_error"]) {
    const url = tasksRedirect("filter=high&page=3", { ticktick: code });
    const qs = new URLSearchParams(url.split("?")[1]);
    assert.equal(qs.get("ticktick"), code);
    assert.equal(qs.get("filter"), "high");
    assert.equal(qs.get("page"), "3");
  }
});

test("only whitelisted view keys are reflected — arbitrary params are ignored", () => {
  const url = tasksRedirect("filter=high&evil=1&redirect=http://x&page=2", { ttplan: "t1", pa: "skip" });
  const qs = new URLSearchParams(url.split("?")[1]);
  assert.equal(qs.get("filter"), "high");
  assert.equal(qs.get("page"), "2");
  assert.equal(qs.get("evil"), null, "arbitrary param must not be reflected");
  assert.equal(qs.get("redirect"), null, "no open-redirect passthrough");
});

test("empty extra values are omitted (never emits key=)", () => {
  const url = tasksRedirect("filter=high", { ttplan: "", pa: "" });
  assert.equal(url, "/v2/tasks?filter=high");
});

test("no view + no extra → the bare route", () => {
  assert.equal(tasksRedirect(undefined, {}), "/v2/tasks");
});
