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
  for (const [name, src] of [["adapter", ADAPTER], ["mapper", MAPPER], ["timeline-provider", PROVIDER]] as const) {
    for (const banned of ['server-only', "fetch(", "supabase", "createClient", "process.env", "Date.now", "new Date(", "Math.random", "TICKTICK_ACCESS_TOKEN"]) {
      assert.ok(!src.includes(banned), `${name} must not contain ${banned}`);
    }
  }
});

test("adapter + mapper carry no engine/business logic", () => {
  for (const [name, src] of [["adapter", ADAPTER], ["mapper", MAPPER]] as const) {
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
