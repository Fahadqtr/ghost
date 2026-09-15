// ACC-02B batch 2 — writer-migration guards for the five tables whose direct
// `authenticated`-client writes were moved to the service role:
//
//   products · product_images · channel_products · platform_status · agent_logs
//
// The centrepiece is a SCOPE-RESOLVED scanner. A file-level or name-level scan
// is not good enough here and actively misleads: app/(app)/products/actions.ts
// binds the name `supabase` to createAdminClient() inside the migrated actions
// and to createClient() in two others, so "does this file mention createClient"
// and "is this variable ever a session client" both give the wrong answer. The
// scanner below resolves each write to the NEAREST PRECEDING BINDING of the
// exact variable it is called on — the same method used to produce the audit.
//
// It fails if anyone introduces a new authenticated write to these tables,
// whether directly or by handing a session client to one of the shared cores.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/security/acc02b-batch2-writer-migration.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const TARGETS = ["products", "product_images", "channel_products", "platform_status", "agent_logs"] as const;

/** Shared helpers that write a target table using whatever client they are given. */
const CORES = [
  "createProductCore", "createProductsBatchCore", "updateProductCore",
  "writeProductAvailability", "writeProductEnrichment", "storePrimaryProductImage",
] as const;

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", ".turbo"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.includes(".test.")) out.push(full);
  }
  return out;
}

/**
 * Resolve which client a variable holds at a given line, by walking BACKWARDS to
 * its nearest binding. Returns "authenticated" only when that binding is
 * createClient() — the session client.
 */
function bindingKind(lines: string[], atLine: number, varName: string): string {
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?::[^=]+)?=\\s*(?:await\\s+)?(\\w+)\\(`);
  for (let i = atLine; i >= 0; i--) {
    const m = decl.exec(lines[i]);
    if (m) {
      switch (m[1]) {
        case "createAdminClient":
        case "adminClient":
        // writableClient() returns createAdminClient(), falling back to the
        // session client ONLY when the service-role key is absent. In production
        // the key is set; after the grant revocation that fallback fails closed
        // instead of writing as `authenticated`, which is the safer outcome.
        case "writableClient":
          return "service_role";
        case "createClient":
          return "authenticated";
        default:
          return `via:${m[1]}`;
      }
    }
  }
  return "param/unknown";
}

type Hit = { table: string; file: string; line: number; detail: string };

function scanAuthenticatedWriters(): Hit[] {
  const hits: Hit[] = [];
  const tablesAlt = TARGETS.join("|");
  const writeRe = new RegExp(`\\b(\\w+)\\s*\\n?\\s*\\.from\\("(${tablesAlt})"\\)([\\s\\S]{0,400}?)(?=\\bawait\\b|\\bconst\\b|\\breturn\\b|\\n\\n|$)`, "g");
  const mutation = /\.(insert|update|upsert|delete)\(/;

  for (const abs of walk(path.join(ROOT, "app")).concat(walk(path.join(ROOT, "lib")))) {
    const src = readFileSync(abs, "utf8");
    const rel = path.relative(ROOT, abs);
    const lines = src.split("\n");

    if (TARGETS.some((t) => src.includes(`"${t}"`))) {
      writeRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = writeRe.exec(src)) !== null) {
        if (!mutation.test(m[3])) continue;
        const line = src.slice(0, m.index).split("\n").length - 1;
        if (bindingKind(lines, line, m[1]) === "authenticated") {
          hits.push({ table: m[2], file: rel, line: line + 1, detail: `direct write on "${m[1]}"` });
        }
      }
    }

    for (const core of CORES) {
      const coreRe = new RegExp(`${core}\\(\\s*(\\w+)`, "g");
      let c: RegExpExecArray | null;
      while ((c = coreRe.exec(src)) !== null) {
        const line = src.slice(0, c.index).split("\n").length - 1;
        if (bindingKind(lines, line, c[1]) === "authenticated") {
          hits.push({ table: "products", file: rel, line: line + 1, detail: `${core}(${c[1]}) — session client into a shared write core` });
        }
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

test("GUARD: no authenticated-client writer exists for any of the five tables", () => {
  const hits = scanAuthenticatedWriters();
  const report = hits.map((h) => `  ${h.table}: ${h.file}:${h.line} — ${h.detail}`).join("\n");
  assert.equal(hits.length, 0,
    `Found ${hits.length} direct authenticated write(s) to ACC-02B batch-2 tables.\n` +
    `These tables have no INSERT/UPDATE/DELETE grant for \`authenticated\`, so this write WILL FAIL at runtime.\n` +
    `Move it to createAdminClient() behind the existing authorization gate:\n${report}`);
});

test("GUARD: the scanner actually detects a session-client write (it is not vacuous)", () => {
  // A scanner that can never fail proves nothing — exercise bindingKind directly.
  const fake = [
    "const supabase = createClient();",
    'await supabase.from("products").update({ a: 1 });',
  ];
  assert.equal(bindingKind(fake, 1, "supabase"), "authenticated");
  const fakeAdmin = [
    "const supabase = createAdminClient();",
    'await supabase.from("products").update({ a: 1 });',
  ];
  assert.equal(bindingKind(fakeAdmin, 1, "supabase"), "service_role");
});

test("GUARD: scope resolution beats name resolution in the same file", () => {
  // This is the exact shape of app/(app)/products/actions.ts after migration:
  // the same NAME is a service-role client in one action and a session client in
  // another. A name-level scan would report a false positive here.
  const mixed = [
    "export async function migrated() {",
    "  const supabase = createAdminClient();",
    '  await supabase.from("products").update({});',
    "}",
    "export async function readOnly() {",
    "  const supabase = createClient();",
    '  await supabase.from("staff_tasks").select();',
    "}",
  ];
  assert.equal(bindingKind(mixed, 2, "supabase"), "service_role");
  assert.equal(bindingKind(mixed, 6, "supabase"), "authenticated");
});

// ---------------------------------------------------------------------------
// Gate-before-privileged-mutation, per migrated action
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

/** action -> [file, expected gate] */
const MIGRATED: [string, string, "requireMalakWriter" | "requireOwner" | "requireWriterGate" | "requireUser"][] = [
  ["setProductApproval", "app/(app)/products/actions.ts", "requireMalakWriter"],
  ["setProductsApproval", "app/(app)/products/actions.ts", "requireMalakWriter"],
  ["setProductStatus", "app/(app)/products/actions.ts", "requireMalakWriter"],
  ["deleteProduct", "app/(app)/products/actions.ts", "requireOwner"],
  ["deleteProductById", "app/(app)/catalog/health/actions.ts", "requireOwner"],
  ["enrichProduct", "app/(app)/catalog/enrich/actions.ts", "requireMalakWriter"],
  ["setPlatformApproval", "app/(app)/platforms/actions.ts", "requireMalakWriter"],
  ["setChannelStatus", "app/(app)/channels/actions.ts", "requireMalakWriter"],
  ["applyReconciledAvailability", "app/(app)/import-export/availability-actions.ts", "requireMalakWriter"],
  ["applyReconciledToShopify", "app/(app)/import-export/availability-actions.ts", "requireMalakWriter"],
  ["setPureSeoulApproval", "app/(app)/import-export/pure-seoul-actions.ts", "requireMalakWriter"],
  ["applyPureSeoulAvailability", "app/(app)/import-export/pure-seoul-actions.ts", "requireMalakWriter"],
  ["logAgentCommand", "app/(app)/agents/actions.ts", "requireUser"],
];

test("every migrated action gates BEFORE it constructs the service-role client", () => {
  for (const [fn, file, gate] of MIGRATED) {
    const body = fnBody(read(file), fn);
    const gateAt = body.indexOf(gate);
    assert.notEqual(gateAt, -1, `${fn}: expected gate ${gate}()`);
    const adminAt = body.indexOf("createAdminClient(");
    if (adminAt !== -1) {
      assert.ok(gateAt < adminAt,
        `${fn}: ${gate}() must run BEFORE createAdminClient() — otherwise a denied call has already built a privileged client`);
    }
    // A denial must return before any statement runs.
    assert.match(body, /return\s*\{[^}]*error/,
      `${fn}: the gate's denial must return an error result`);
  }
});

test("setPlatformApproval was RAISED to the writer gate, not left on a session check", () => {
  const body = fnBody(read("app/(app)/platforms/actions.ts"), "setPlatformApproval");
  assert.match(body, /requireMalakWriter\(\)/, "approval is a catalog mutation → writer boundary");
  assert.doesNotMatch(body, /auth\.getUser\(\)/,
    "the inline 'is anybody signed in' check must be gone");
  assert.doesNotMatch(body, /"غير مسجّل الدخول\."/,
    "the old signed-in-only denial must be gone");
});

test("logAgentCommand keeps its ORIGINAL gate — the migration must not widen or narrow it", () => {
  const body = fnBody(read("app/(app)/agents/actions.ts"), "logAgentCommand");
  assert.match(body, /requireUser\(\)/,
    "this is a SYSTEM-SERVICE bookkeeping write; who may call it is an open question, not one this step answers");
  assert.doesNotMatch(body, /requireOwner|requireMalakWriter/,
    "raising this gate is an owner decision, not a side effect of the client migration");
});

// ---------------------------------------------------------------------------
// The shared write cores must not be reachable with a session client
// ---------------------------------------------------------------------------

test("importOneProduct no longer accepts a session client at all", () => {
  const src = read("lib/missing-products/catalog-import.server.ts");
  assert.doesNotMatch(src, /session\s*:\s*SessionClient/,
    "the unused session parameter must be removed, not left as a trap for the next caller");
  assert.match(src, /createProductCore\(\s*\n?\s*admin as never/,
    "the product insert must run on the admin client");
});

test("the v2 catalog write paths pass the admin client to the shared cores", () => {
  for (const [file, core] of [
    ["app/(v2)/v2/catalog/new/actions.ts", "createProductCore"],
    ["app/(v2)/v2/catalog/import/actions.ts", "createProductCore"],
    ["app/(v2)/v2/catalog/[id]/edit/actions.ts", "updateProductCore"],
    ["app/(v2)/v2/catalog/launch/wave2/actions.ts", "updateProductCore"],
  ] as const) {
    const src = stripComments(read(file));
    assert.match(src, new RegExp(`${core}\\(\\s*admin`),
      `${file}: ${core} must receive the admin client`);
    assert.doesNotMatch(src, new RegExp(`${core}\\(\\s*supabase`),
      `${file}: ${core} must NOT receive the session client`);
  }
});
