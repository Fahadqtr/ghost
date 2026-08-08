// TickTick integration source-safety scans (Phase UI.7.5): secrets stay
// server-side, no token logging, the pure layers do no I/O and carry no business
// rules, and the browser never sees a token. Run:
// node --conditions=react-server --experimental-strip-types --test lib/integrations/ticktick/security.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const CLIENT = read("./client.ts");
const ADAPTER = read("./adapter.ts");
const MAPPER = read("./mapper.ts");
const PROVIDER = read("./timeline-provider.ts");
const SMARTTASKS = read("../../../components/v2/operations/SmartTasks.tsx");
const PAGE = read("../../../app/(v2)/v2/tasks/page.tsx");
const ACTIONS = read("../../../app/(v2)/v2/tasks/actions.ts");
const PROJECTS = read("./projects.ts");
const PROJECTS_PAGE = read("../../../app/(v2)/v2/settings/integrations/ticktick/page.tsx");
const COPY_BTN = read("../../../app/(v2)/v2/settings/integrations/ticktick/CopyProjectId.tsx");

test("client is server-only, times out, handles rate limits, and never logs the token", () => {
  assert.ok(CLIENT.includes('import "server-only"'), "client must be server-only");
  assert.ok(CLIENT.includes("AbortSignal.timeout"), "client must set a timeout");
  assert.ok(CLIENT.includes("429"), "client must handle rate limiting");
  assert.ok(!CLIENT.includes("console.log"), "client must not console.log");
  // the token is only ever placed in the Authorization header, never logged
  assert.ok(!/console\.[a-z]+\([^)]*(tok|Authorization|Bearer)/i.test(CLIENT), "token/Authorization must never be logged");
  assert.ok(!CLIENT.includes("NEXT_PUBLIC_TICKTICK"), "no public token env");
});

test("the pure layers do NO I/O, keep no clock, and hold no secrets", () => {
  for (const [name, src] of [["adapter", ADAPTER], ["mapper", MAPPER], ["timeline-provider", PROVIDER], ["projects", PROJECTS]] as const) {
    for (const banned of ['server-only', "fetch(", "supabase", "createClient", "process.env", "Date.now", "new Date(", "Math.random", "TICKTICK_ACCESS_TOKEN"]) {
      assert.ok(!src.includes(banned), `${name} must not contain ${banned}`);
    }
  }
});

test("adapter + mapper + projects carry no engine/business logic", () => {
  for (const [name, src] of [["adapter", ADAPTER], ["mapper", MAPPER], ["projects", PROJECTS]] as const) {
    for (const banned of ["computeProductReadiness", "generateProductTasks", "task-engine", "readiness/readiness"]) {
      assert.ok(!src.includes(banned), `${name} must not re-implement business logic (${banned})`);
    }
  }
});

test("the browser never receives a TickTick token: no client-side client import, no token name", () => {
  // SmartTasks is a server component; it may import the server ACTION but never
  // the server-only client, and never references the token env.
  assert.ok(!SMARTTASKS.includes("integrations/ticktick/client"), "UI must not import the TickTick client");
  assert.ok(!SMARTTASKS.includes("TICKTICK_ACCESS_TOKEN"));
  assert.ok(!SMARTTASKS.includes('"use client"'), "SmartTasks is a server component");
  assert.ok(!PAGE.includes("TICKTICK_ACCESS_TOKEN"), "page must not reference the token env");
});

test("the manual sync action is a server action gated by the owner", () => {
  assert.ok(ACTIONS.includes('"use server"'), "actions must be a server module");
  assert.ok(ACTIONS.includes("requireOwner"), "sync must be owner-gated");
  assert.ok(!ACTIONS.includes("TICKTICK_ACCESS_TOKEN"), "action must not reference the token env directly");
});

test("single-task actions: owner-gated, server-derived, dry-run preview, scoped sync", () => {
  // both single-task actions exist and re-derive the task server-side (never trust
  // the client) — only the task id is passed from the browser.
  assert.ok(ACTIONS.includes("previewOneTickTickTask"), "preview action must exist");
  assert.ok(ACTIONS.includes("syncOneTickTickTask"), "single-task sync action must exist");
  assert.ok(ACTIONS.includes("loadTasksView"), "actions re-derive tasks from the Operations reader");
  // the preview uses the dry-run planner (no writes), never the writing sync.
  assert.ok(ACTIONS.includes("previewOperationTaskSync"), "preview must use the dry-run planner");
  // the single-task sync opts out of the completion sweep → touches only one task.
  assert.ok(ACTIONS.includes("completeMissing: false"), "single-task sync must not sweep-complete other tasks");
  // the actions take ONLY the id — no project id / title / description from the client.
  assert.ok(!ACTIONS.includes("formData"), "single-task actions take only the task id, no client-supplied fields");
  assert.ok(!ACTIONS.includes("projectId:") || ACTIONS.includes("projectMap: projectMapFromEnv()"),
    "project routing comes from env, never the client");
});

test("single-task TickTick UI: owner-gated buttons + fixed unconfigured notice, no client JS", () => {
  assert.ok(SMARTTASKS.includes("معاينة TickTick"), "preview button present");
  assert.ok(SMARTTASKS.includes("مزامنة هذه المهمة"), "single-task sync button present");
  assert.ok(SMARTTASKS.includes("قائمة TickTick لهذه المهمة غير مهيأة."), "fixed unconfigured notice present");
  assert.ok(SMARTTASKS.includes("previewOneTickTickTask"), "wires the preview server action");
  assert.ok(SMARTTASKS.includes("syncOneTickTickTask"), "wires the single-task sync server action");
  assert.ok(!SMARTTASKS.includes('"use client"'), "SmartTasks stays a server component");
  // the buttons pass the task id (+ the non-sensitive current view) via a bound
  // server action — never task fields like title/description/project id.
  assert.ok(SMARTTASKS.includes(".bind(null, task.id,"), "buttons bind the task id");
});

test("preview fix: the button targets the clicked task AND round-trips the view", () => {
  // clicking معاينة TickTick submits a form whose action is previewOneTickTickTask
  // bound to THIS card's task id + the current view query string.
  assert.ok(
    /previewOneTickTickTask\.bind\(null, task\.id, viewQS\)/.test(SMARTTASKS),
    "preview button binds the correct task id + view",
  );
  assert.ok(
    /syncOneTickTickTask\.bind\(null, task\.id, viewQS\)/.test(SMARTTASKS),
    "revealed sync button binds the correct task id + view",
  );
  // the actions carry that view into the redirect via the pure tasks-nav helper,
  // so the result lands on the same page/filter the owner previewed from.
  assert.ok(ACTIONS.includes("tasksRedirect"), "actions preserve the view via tasksRedirect");
  assert.ok(ACTIONS.includes("view?: string"), "single-task actions accept the bound view");
});

test("preview fix: 'فتح المنتج' is untouched — still a plain product Link (GET)", () => {
  assert.ok(
    /href=\{`\/v2\/catalog\/\$\{encodeURIComponent\(item\.productId\)\}`\}/.test(SMARTTASKS),
    "open-product stays a Link to /v2/catalog/[id], not a form/action",
  );
});

test("preview fix: the view helper is pure (no I/O, no secrets, no business logic)", () => {
  const NAV = read("./tasks-nav.ts");
  for (const banned of ['server-only', "fetch(", "supabase", "createClient", "process.env", "Date.now", "new Date(", "TICKTICK_ACCESS_TOKEN", "computeProductReadiness", "generateProductTasks", "task-engine"]) {
    assert.ok(!NAV.includes(banned), `tasks-nav must not contain ${banned}`);
  }
  // it only reflects the whitelisted view keys — no arbitrary/open-redirect passthrough.
  assert.ok(NAV.includes('["query", "filter", "page"]'), "only whitelisted view keys are reflected");
});

test("project browser: owner-gated page, read-only, no writes, no token leakage", () => {
  // owner-only gate present, and the constant denial is rendered for non-owners.
  assert.ok(PROJECTS_PAGE.includes("isOwner"), "page must be owner-gated");
  assert.ok(PROJECTS_PAGE.includes("OWNER_ONLY_DENIED"), "page renders the constant owner denial");
  // reads projects through the server-only client (never a direct token read).
  assert.ok(PROJECTS_PAGE.includes("loadTickTickProjectBrowser"), "page uses the read-only browser loader");
  // the fixed states are all present as fixed Arabic text.
  assert.ok(PROJECTS_PAGE.includes("TickTick غير مربوط."), "not-connected message present");
  assert.ok(PROJECTS_PAGE.includes("لا توجد قوائم"), "empty-list message present");
  // NEVER any write endpoint or token/Authorization in the page or the loader path.
  for (const [name, src] of [["projects", PROJECTS], ["projects-page", PROJECTS_PAGE]] as const) {
    for (const banned of ["createTask", "updateTask", "completeTask", 'method: "POST"', 'method: "DELETE"', 'method: "PUT"', "TICKTICK_ACCESS_TOKEN", "Authorization", "Bearer"]) {
      assert.ok(!src.includes(banned), `${name} must not reference ${banned}`);
    }
  }
});

test("project browser: pure module only reads (no createTask/updateTask/completeTask on its client dep)", () => {
  // the pure planner depends on a single read capability — listProjects — so a
  // write path cannot exist through it, and it never GETs a token env directly.
  assert.ok(PROJECTS.includes("listProjects"), "planner exposes the read capability");
  assert.ok(!PROJECTS.includes("process.env"), "pure module reads no env");
});

test("project browser: copy button is a leaf client island receiving only the public id", () => {
  assert.ok(COPY_BTN.includes('"use client"'), "copy button is a client component");
  assert.ok(COPY_BTN.includes("نسخ Project ID"), "copy button label present");
  // it must not import server-only code or reference the token in any form.
  assert.ok(!COPY_BTN.includes("integrations/ticktick/client"), "copy button must not import the TickTick client");
  assert.ok(!COPY_BTN.includes("TICKTICK_ACCESS_TOKEN"));
  assert.ok(!COPY_BTN.includes("Authorization"));
});
