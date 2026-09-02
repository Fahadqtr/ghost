import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildMasterScope,
  isMember,
  scopeRows,
  scopeRowsKeepingGlobal,
  UNAVAILABLE_SCOPE,
} from "./master-scope.ts";
import { readMasterScope, type ScopeReadClient, type ScopeRangeBuilder } from "./master-scope.server.ts";

const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ── pure membership helpers ──────────────────────────────────────────────────

test("buildMasterScope: derives the master size from the rows — never a constant", () => {
  const scope = buildMasterScope([{ product_id: "p1" }, { product_id: "p2" }, { product_id: "p3" }]);
  assert.equal(scope.ok, true);
  assert.equal(scope.total, 3);
  assert.equal(scope.total, scope.ids.size, "total is always derived from ids");
});

test("buildMasterScope: duplicate listings for one product count once", () => {
  const scope = buildMasterScope([{ product_id: "p1" }, { product_id: "p1" }, { product_id: "p1" }]);
  assert.equal(scope.total, 1);
});

test("buildMasterScope: malformed rows are ignored, never admitted", () => {
  const scope = buildMasterScope([null, 42, "p1", {}, { product_id: null }, { product_id: "" }, { product_id: "p9" }]);
  assert.deepEqual([...scope.ids], ["p9"]);
});

test("scopeRows: outside-master rows are dropped", () => {
  const scope = buildMasterScope([{ product_id: "a" }, { product_id: "c" }]);
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  assert.deepEqual(scopeRows(rows, (r) => r.id, scope).map((r) => r.id), ["a", "c"]);
});

test("scopeRows: an UNAVAILABLE scope yields EMPTY, never the unfiltered input", () => {
  const rows = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(scopeRows(rows, (r) => r.id, UNAVAILABLE_SCOPE), [], "fails closed");
});

test("scopeRowsKeepingGlobal: keeps catalog-wide rows, drops outside-master ones", () => {
  const scope = buildMasterScope([{ product_id: "a" }]);
  const rows = [{ entityId: "a" }, { entityId: "b" }, { entityId: null }];
  assert.deepEqual(
    scopeRowsKeepingGlobal(rows, (r) => r.entityId, scope).map((r) => r.entityId),
    ["a", null],
  );
});

test("isMember: only non-empty string ids in the set are members", () => {
  const scope = buildMasterScope([{ product_id: "a" }]);
  assert.equal(isMember(scope, "a"), true);
  for (const bad of ["b", "", null, undefined, 1, {}]) assert.equal(isMember(scope, bad), false);
});

// ── membership reader ────────────────────────────────────────────────────────

interface Call { table: string; columns: string; filters: [string, string, string][]; range: [number, number] }

function fakeClient(cfg: { rows?: unknown[]; fail?: boolean; throws?: boolean }): { client: ScopeReadClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: ScopeReadClient = {
    from(table: string) {
      return {
        select(columns: string) {
          const filters: [string, string, string][] = [];
          let pending: { data: unknown[] | null; error: unknown } = { data: [], error: null };
          const b: ScopeRangeBuilder = {
            filter(c: string, op: string, v: string) { filters.push([c, op, v]); return b; },
            order() { return b; },
            range(from: number, to: number) {
              calls.push({ table, columns, filters: filters.map((f) => [...f] as [string, string, string]), range: [from, to] });
              if (cfg.throws) throw new Error("BUILDER BOOM SECRET");
              pending = cfg.fail
                ? { data: null, error: { message: "SCOPE SECRET", code: "42P01" } }
                : { data: (cfg.rows ?? []).slice(from, to + 1), error: null };
              return b;
            },
            then(onf, onr) { return Promise.resolve(pending).then(onf as never, onr as never); },
          };
          return b;
        },
      };
    },
  };
  return { client, calls };
}

test("readMasterScope: filters to snoonu:malikas + active and selects product_id only", async () => {
  const { client, calls } = fakeClient({ rows: [{ product_id: "p1" }, { product_id: "p2" }] });
  const scope = await readMasterScope(client);
  assert.equal(scope.ok, true);
  assert.equal(scope.total, 2);
  assert.equal(calls[0].table, "external_channel_listings");
  assert.equal(calls[0].columns, "product_id", "membership read exposes no external ids");
  assert.deepEqual(calls[0].filters, [
    ["storefront_key", "eq", "snoonu:malikas"],
    ["mapping_status", "eq", "active"],
  ]);
});

test("readMasterScope: a read failure FAILS CLOSED and leaks no error text", async () => {
  const { client } = fakeClient({ fail: true });
  const scope = await readMasterScope(client);
  assert.equal(scope.ok, false);
  assert.equal(scope.total, 0);
  const json = JSON.stringify({ ...scope, ids: [...scope.ids] });
  for (const leak of ["SCOPE SECRET", "42P01"]) assert.ok(!json.includes(leak), `leaked: ${leak}`);
});

test("readMasterScope: a builder throw FAILS CLOSED", async () => {
  const { client } = fakeClient({ throws: true });
  const scope = await readMasterScope(client);
  assert.equal(scope.ok, false);
  assert.ok(!JSON.stringify({ ...scope, ids: [...scope.ids] }).includes("BOOM"));
});

test("readMasterScope: zero active listings → empty master, NOT all products", async () => {
  const { client } = fakeClient({ rows: [] });
  const scope = await readMasterScope(client);
  assert.equal(scope.ok, true, "an empty master is a successful read, not a failure");
  assert.equal(scope.total, 0);
  assert.deepEqual(scopeRows([{ id: "x" }, { id: "y" }], (r) => r.id, scope), [], "nothing leaks through");
});

// ── source guarantees ────────────────────────────────────────────────────────

test("master scope sources: read-only, no writes, and no hardcoded master size", () => {
  for (const rel of ["./master-scope.ts", "./master-scope.server.ts"]) {
    const src = strip(readFileSync(new URL(rel, import.meta.url), "utf8"));
    for (const [re, msg] of [
      [/\.insert\s*\(/, ".insert("],
      [/\.update\s*\(/, ".update("],
      [/\.upsert\s*\(/, ".upsert("],
      [/\.delete\s*\(/, ".delete("],
      [/\.rpc\s*\(/, ".rpc("],
      [/\bfetch\s*\(/, "fetch("],
      [/createAdminClient/, "createAdminClient"],
      [/service_role/, "service_role"],
      [/select\(\s*["']\*["']\s*\)/, 'select("*")'],
      [/\b1343\b/, "hardcoded master size"],
    ] as const) {
      assert.equal(re.test(src), false, `${rel} must not contain ${msg}`);
    }
  }
});
