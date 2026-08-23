// PRODUCT.APPROVAL.UX.1 — product-detail approval action guard (source scan).
//
// Pins the phase contract:
//   1. The approve action DELEGATES to the canonical writer (setProductApproval)
//      — no direct SQL/table write, no second approval system.
//   2. Server-side authorization runs BEFORE any work (writer gate; the
//      canonical writer keeps its own gate too).
//   3. Approval NEVER activates: the approve action never calls the lifecycle
//      boundary and never writes lifecycle/approval fields itself.
//   4. The panel shows «اعتماد المنتج» ONLY for unapproved products, requires
//      an explicit confirmation step, and refreshes the page on success so
//      readiness/lifecycle (and the existing تفعيل button) recompute.
//   5. No unrelated catalog mutation: the touched files gained no other write.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/lifecycle/product-approval-ux-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const ACTIONS = "app/(v2)/v2/catalog/[id]/actions.ts";
const PANEL = "components/v2/catalog/LifecyclePanel.tsx";
const PAGE = "app/(v2)/v2/catalog/[id]/page.tsx";

function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} exists`);
  const next = src.indexOf("export async function", start + 10);
  return src.slice(start, next === -1 ? undefined : next);
}

test("1. approve action delegates to the canonical setProductApproval writer", () => {
  const src = code(ACTIONS);
  assert.ok(
    src.includes('import { setProductApproval } from "@/app/(app)/products/actions"'),
    "imports the canonical quick-approve boundary (task-log audit + Talabat queue live there)",
  );
  const body = fnBody(src, "approveProductFromDetail");
  assert.ok(body.includes('setProductApproval(id, "Approved")'), "delegates with the exact house value");
  for (const token of [".update(", ".insert(", ".upsert(", ".delete(", ".rpc("]) {
    assert.ok(!src.includes(token), `actions file must not contain ${token}`);
  }
});

test("2. writer gate runs before any work in the approve action", () => {
  const body = fnBody(code(ACTIONS), "approveProductFromDetail");
  const gate = body.indexOf("requireWriterGate()");
  const write = body.indexOf("setProductApproval(");
  assert.ok(gate >= 0 && write >= 0 && gate < write, "gate strictly precedes the delegated write");
});

test("3. approval never activates and never writes approval/lifecycle fields itself", () => {
  const body = fnBody(code(ACTIONS), "approveProductFromDetail");
  assert.ok(!body.includes("transitionProductLifecycle"), "approve must NOT touch the lifecycle boundary");
  assert.ok(!body.includes("lifecycle_state"), "no lifecycle field write");
  assert.ok(!body.includes("approval:"), "no direct approval field write — delegation only");
  // the transition wrapper still exists, untouched, as the SEPARATE activation path
  assert.ok(code(ACTIONS).includes("transitionProductLifecycle(input)"), "activation path unchanged");
});

test("4. panel: approval button only when NOT approved, with explicit confirmation + refresh", () => {
  const src = code(PANEL);
  assert.ok(src.includes("!view.approved && approveAction"), "button gated on the unapproved state");
  assert.ok(src.includes("اعتماد المنتج"), "the exact operator label");
  assert.ok(src.includes("تأكيد اعتماد المنتج"), "explicit confirmation step before executing");
  assert.ok(src.includes("setConfirmingApprove(true)"), "click opens confirmation, never executes directly");
  assert.ok(src.includes("router.refresh()"), "successful approval refreshes readiness/lifecycle");
  assert.ok(
    src.includes("لا يفعّل المنتج"),
    "confirmation copy states approval does NOT activate (two separate actions)",
  );
  // The panel is presentation only: no supabase, no fetch to write endpoints.
  assert.ok(!src.includes("createClient") && !src.includes("supabase"), "panel holds no data client");
});

test("5. page wires the delegate; no other mutation was added to the detail page", () => {
  const src = code(PAGE);
  assert.ok(src.includes("approveAction={approveProductFromDetail}"), "panel receives the thin delegate");
  for (const token of [".update(", ".insert(", ".upsert(", ".delete("]) {
    assert.ok(!src.includes(token), `detail page must not contain ${token}`);
  }
});
