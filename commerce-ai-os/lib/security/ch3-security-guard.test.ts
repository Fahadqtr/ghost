// CH.3 — security hardening guard (source scan). Pins the invariants CH.3
// established so a later edit cannot silently regress them:
//   1. the service-role factory is a HARD server-only boundary;
//   2. no Client Component imports the service-role factory (no key in the browser);
//   3. the hardened externally-reachable channel actions never RETURN a raw DB /
//      driver error (they route through safeError → fixed public message);
//   4. the Snoonu / Pure Seoul service-role catalog mutations keep an auth gate
//      (the shared isSignedIn helper) — no ad-hoc inline session gate;
//   5. the safe-error helper stays pure (framework-free, node:test loadable).
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/security/ch3-security-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const HARDENED = [
  "app/(app)/import-export/snoonu-actions.ts",
  "app/(app)/import-export/pure-seoul-actions.ts",
  "app/(app)/import-export/talabat-actions.ts",
  "app/(app)/channels/actions.ts",
] as const;

test("1. the service-role factory declares the server-only boundary", () => {
  const src = read("lib/supabase/admin.ts");
  assert.ok(/^\s*import\s+["']server-only["'];/m.test(src), "admin.ts must import 'server-only'");
});

test("2. no Client Component imports the service-role factory", () => {
  const dirs = ["app", "components", "lib"];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(join(ROOT, dir)); } catch { return; }
    for (const name of entries) {
      const rel = join(dir, name);
      const abs = join(ROOT, rel);
      if (statSync(abs).isDirectory()) { if (name !== "node_modules") walk(rel); continue; }
      if (!/\.(ts|tsx)$/.test(rel) || /\.test\.(ts|tsx)$/.test(rel)) continue;
      const src = readFileSync(abs, "utf8");
      const isClient = /^\s*["']use client["']/m.test(src.split("\n").slice(0, 3).join("\n"));
      if (isClient && /supabase\/admin/.test(src)) offenders.push(rel);
    }
  };
  dirs.forEach(walk);
  assert.deepEqual(offenders, [], `client components must not import the service-role factory: ${offenders.join(", ")}`);
});

test("3. hardened channel actions never RETURN a raw DB/driver error", () => {
  const LEAK = [
    /error:\s*error\.message/,
    /error:\s*e\.message/,
    /error:\s*e\s+instanceof\s+Error\s*\?\s*e\.message/,
    /error:\s*[^,\n}]*\$\{[^}]*\.error\?\.message/,
    /error:\s*`[^`]*\$\{\s*(error|e|retry\.error)\.message/,
  ];
  for (const f of HARDENED) {
    const src = strip(read(f));
    for (const re of LEAK) {
      assert.equal(re.test(src), false, `${f} must not return a raw error (matched ${re})`);
    }
    assert.ok(/safeError\(/.test(src), `${f} must route errors through safeError`);
  }
});

test("4. Snoonu / Pure Seoul service-role mutations keep the shared auth gate", () => {
  for (const f of ["app/(app)/import-export/snoonu-actions.ts", "app/(app)/import-export/pure-seoul-actions.ts"]) {
    const src = strip(read(f));
    assert.ok(/isSignedIn\s*\(/.test(src), `${f} must use the shared isSignedIn gate`);
    // the ad-hoc inline gate idiom must be gone (replaced by the shared helper)
    assert.equal(/if\s*\(\s*!\s*user\s*\)/.test(src), false, `${f} must not keep an ad-hoc inline "if (!user)" gate`);
    // and every service-role handle is still created (mutations still exist)
    assert.ok(/createAdminClient\(/.test(src), `${f} still performs service-role writes`);
  }
});

test("5. the safe-error helper is framework-free (pure)", () => {
  const src = read("lib/security/safe-error.ts");
  assert.equal(/from\s+["']@\//.test(src), false, "no @/ alias imports");
  assert.equal(/from\s+["'](react|next|@supabase|server-only)/.test(src), false, "no framework imports");
});
