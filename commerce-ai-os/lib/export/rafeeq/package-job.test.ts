// RAFEEQ.PKGJOB — chunked package-generation engine tests (pure, fake ports).
//
// Drives the full job lifecycle the way the server adapter does — bounded
// steps, durable parts, resumable state — and proves:
//   • the assembled parts form a structurally valid ZIP (EOCD / central
//     directory / local headers / CRCs) with the audited layout names;
//   • bounded memory: many small parts, never one whole-archive buffer;
//   • transient image failure retries on the next step; permanent failure
//     drops the product as excluded-no-image (never aborts the catalog);
//   • completed/failed jobs are idempotent no-ops; retries never re-record;
//   • the durable history record happens EXACTLY ONCE, only after the artifact
//     is fully committed;
//   • failures are structured {code, refId} — never raw text/HTML.
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/package-job.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "../../net/zip.ts";
import { buildRafeeqPreview, type RafeeqPreviewProduct, type RafeeqPreviewVariant } from "./preview.ts";
import {
  createRafeeqPackageJob,
  advanceRafeeqPackageJob,
  jobProgress,
  RAFEEQ_JOB_ERROR_AR,
  type RafeeqPackageJobState,
  type RafeeqPackageJobPlan,
  type RafeeqJobPorts,
} from "./package-job.ts";
import { FULLSYNC_MANIFEST_NAME } from "./fullsync.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

function variant(id: string, sku: string, over: Partial<RafeeqPreviewVariant> = {}): RafeeqPreviewVariant {
  return { id, sku, barcode: "6291041500301", nameEn: `Option ${id}`, nameAr: `خيار ${id}`, price: null, ...over };
}
function product(id: string, sku: string, over: Partial<RafeeqPreviewProduct> = {}): RafeeqPreviewProduct {
  return {
    id, sku, barcode: "6291041500213",
    nameEn: `Product ${sku}`, nameAr: `منتج ${sku}`,
    category: "Makeup", price: 100, discountPrice: null,
    descriptionEn: "en", descriptionAr: "ar",
    imageUrl: `https://cdn.example.com/${sku}.jpg`, imageFilename: `${sku}.jpg`,
    galleryImageUrls: [], imageCount: 1,
    lifecycleState: "ACTIVE", platformStatus: "Active",
    ...over,
  };
}

function fixtureRows(n = 5) {
  const products: RafeeqPreviewProduct[] = [];
  for (let i = 1; i <= n; i++) {
    products.push(product(`p${i}`, `mk${i}`, i === 2
      ? { galleryImageUrls: [`https://cdn.example.com/mk2_g.jpg`], variants: [variant("v1", "mk2-1-red", { nameEn: "Red" }), variant("v2", "mk2-2-gold", { nameEn: "Gold" })] }
      : {}));
  }
  return buildRafeeqPreview({ products }).rows;
}

interface FakeWorld {
  ports: RafeeqJobPorts;
  parts: Map<string, Uint8Array>;
  putSizes: number[];
  fetches: string[];
  failOnce: Set<string>;
  failAlways: Set<string>;
}

function fakeWorld(): FakeWorld {
  const world: FakeWorld = {
    parts: new Map(),
    putSizes: [],
    fetches: [],
    failOnce: new Set(),
    failAlways: new Set(),
    ports: {
      async fetchImage(url: string) {
        world.fetches.push(url);
        if (world.failAlways.has(url)) return null;
        if (world.failOnce.has(url)) {
          world.failOnce.delete(url);
          return null;
        }
        // deterministic per-URL bytes
        const bytes = new TextEncoder().encode(`IMG:${url}:`.repeat(8));
        return { bytes, ext: "jpg" };
      },
      async putPart(path: string, bytes: Uint8Array) {
        world.parts.set(path, bytes.slice());
        world.putSizes.push(bytes.length);
      },
    },
  };
  return world;
}

async function runToCompletion(
  state: RafeeqPackageJobState,
  plan: RafeeqPackageJobPlan,
  world: FakeWorld,
  extra: { recordPackage?: Parameters<typeof advanceRafeeqPackageJob>[2]["recordPackage"]; maxProducts?: number } = {},
): Promise<{ state: RafeeqPackageJobState; steps: number }> {
  let s = state;
  let steps = 0;
  while (s.status === "running" && steps < 100) {
    // serialize/deserialize between steps — exactly what durable storage does
    s = await advanceRafeeqPackageJob(JSON.parse(JSON.stringify(s)), plan, {
      ports: world.ports,
      recordPackage: extra.recordPackage,
      budget: { maxProducts: extra.maxProducts ?? 2 },
    });
    steps += 1;
  }
  return { state: s, steps };
}

function assembled(state: RafeeqPackageJobState, world: FakeWorld): Uint8Array {
  const total = state.parts.reduce((n, p) => n + p.bytes, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of state.parts) {
    const bytes = world.parts.get(p.path);
    assert.ok(bytes, `part exists in storage: ${p.path}`);
    assert.equal(bytes.length, p.bytes, "recorded part size matches stored bytes");
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}

/** Minimal structural ZIP reader: EOCD → central directory → local headers. */
function readZip(zip: Uint8Array): { name: string; crc: number; size: number; offset: number; data: Uint8Array }[] {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocdOff = zip.length - 22;
  assert.equal(dv.getUint32(eocdOff, true), 0x06054b50, "EOCD signature at tail");
  const count = dv.getUint16(eocdOff + 10, true);
  let at = dv.getUint32(eocdOff + 16, true); // central directory offset
  const entries: { name: string; crc: number; size: number; offset: number; data: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(at, true), 0x02014b50, "central header signature");
    const crc = dv.getUint32(at + 16, true);
    const size = dv.getUint32(at + 20, true);
    const nameLen = dv.getUint16(at + 28, true);
    const extraLen = dv.getUint16(at + 30, true);
    const commentLen = dv.getUint16(at + 32, true);
    const offset = dv.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    assert.equal(dv.getUint32(offset, true), 0x04034b50, `local header at recorded offset for ${name}`);
    const lhNameLen = dv.getUint16(offset + 26, true);
    const data = zip.subarray(offset + 30 + lhNameLen, offset + 30 + lhNameLen + size);
    assert.equal(crc32(data) >>> 0, crc >>> 0, `CRC round-trips for ${name}`);
    entries.push({ name, crc, size, offset, data });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const START = { sentBaseline: new Map<string, string | null>(), actor: "owner@example.com", nowIso: "2026-08-26T00:00:00.000Z" };

// ── tests ────────────────────────────────────────────────────────────────────

test("full lifecycle: bounded steps produce a structurally valid ZIP with the audited layout", async () => {
  const rows = fixtureRows(5);
  const created = createRafeeqPackageJob({ jobId: "job-1", mode: "FULL", previewRows: rows, ...START });
  assert.ok(created.ok);
  const world = fakeWorld();
  const recorded: unknown[] = [];
  const { state } = await runToCompletion(created.state, created.plan, world, {
    recordPackage: async (input) => {
      recorded.push(input);
      return { persisted: true, packageId: "pkg-1", itemsPersisted: input.items.length, supersededCount: 0 };
    },
  });

  assert.equal(state.status, "complete");
  assert.ok(state.artifact);
  assert.equal(state.summary?.productRowCount, 5);
  assert.equal(state.summary?.imageCount, 5, "PRIMARY ONLY: one image per included product");
  assert.equal(state.summary?.integrityOk, true);

  const zip = assembled(state, world);
  assert.equal(zip.length, state.artifact.totalBytes, "artifact size = sum of parts");
  const entries = readZip(zip);
  const names = entries.map((e) => e.name);
  assert.ok(names.includes("rafeeq_catalog.xlsx"), "audited xlsx at the ZIP root");
  assert.ok(names.includes(FULLSYNC_MANIFEST_NAME), "manifest at the ZIP root");
  assert.equal(names.filter((n) => n.startsWith("images/")).length, 5, "exactly ONE image file per included product");
  assert.ok(!names.some((n) => /_\d+\.[a-z]+$/.test(n)), "no gallery (_position) file exists in the ZIP");
  // the durable history record happened exactly once, after the artifact
  assert.equal(recorded.length, 1);
  assert.equal(state.packageRecorded?.persisted, true);
  assert.equal(state.packageRecorded?.packageId, "pkg-1");
});

test("bounded memory: many small parts — no single part ever approaches the whole artifact", async () => {
  const rows = fixtureRows(6);
  const created = createRafeeqPackageJob({ jobId: "job-2", mode: "FULL", previewRows: rows, ...START });
  assert.ok(created.ok);
  const world = fakeWorld();
  const { state } = await runToCompletion(created.state, created.plan, world, { maxProducts: 2 });
  assert.equal(state.status, "complete");
  assert.ok(state.parts.length >= 4, `image parts are chunked (got ${state.parts.length})`);
  const total = state.artifact?.totalBytes ?? 0;
  const largestImagePart = Math.max(...state.parts.slice(0, -1).map((p) => p.bytes));
  assert.ok(largestImagePart < total / 2, "no image part holds the archive");
});

test("transient primary failure retries on the NEXT step and still includes the product", async () => {
  const rows = fixtureRows(3);
  const created = createRafeeqPackageJob({ jobId: "job-3", mode: "FULL", previewRows: rows, ...START });
  assert.ok(created.ok);
  const world = fakeWorld();
  const flaky = "https://cdn.example.com/mk3.jpg";
  world.failOnce.add(flaky);
  const { state } = await runToCompletion(created.state, created.plan, world);
  assert.equal(state.status, "complete");
  assert.equal(state.summary?.productRowCount, 3, "the flaky product survived the retry");
  assert.equal(state.summary?.excludedNoImageCount, 0);
  assert.equal(world.fetches.filter((u) => u === flaky).length, 2, "primary was retried exactly once");
  const names = new Set(state.entries.map((e) => e.name));
  assert.equal(names.size, state.entries.length, "no duplicate entries after the retry");
});

test("permanent primary failure drops ONLY that product as excluded-no-image", async () => {
  const rows = fixtureRows(3);
  const created = createRafeeqPackageJob({ jobId: "job-4", mode: "FULL", previewRows: rows, ...START });
  assert.ok(created.ok);
  const world = fakeWorld();
  world.failAlways.add("https://cdn.example.com/mk1.jpg");
  const { state } = await runToCompletion(created.state, created.plan, world);
  assert.equal(state.status, "complete");
  assert.equal(state.summary?.productRowCount, 2);
  assert.equal(state.summary?.excludedNoImageCount, 1);
});

test("idempotent completion: advancing a complete job is a no-op and never re-records", async () => {
  const rows = fixtureRows(2);
  const created = createRafeeqPackageJob({ jobId: "job-5", mode: "FULL", previewRows: rows, ...START });
  assert.ok(created.ok);
  const world = fakeWorld();
  let recordCalls = 0;
  const record = async (input: { items: unknown[] }) => {
    recordCalls += 1;
    return { persisted: true, packageId: "pkg-5", itemsPersisted: input.items.length, supersededCount: 0 };
  };
  const { state } = await runToCompletion(created.state, created.plan, world, { recordPackage: record });
  assert.equal(state.status, "complete");
  assert.equal(recordCalls, 1);
  const again = await advanceRafeeqPackageJob(state, created.plan, { ports: world.ports, recordPackage: record });
  assert.deepEqual(again, state, "complete job advance is an exact no-op");
  assert.equal(recordCalls, 1, "retry after completion NEVER creates a duplicate package record");
});

test("a storage failure fails the job with a structured {code, refId} — never raw text", async () => {
  const rows = fixtureRows(2);
  const created = createRafeeqPackageJob({ jobId: "job-6", mode: "FULL", previewRows: rows, ...START });
  assert.ok(created.ok);
  const world = fakeWorld();
  world.ports.putPart = async () => {
    throw new Error("<!DOCTYPE html> pretend upstream html page");
  };
  const state = await advanceRafeeqPackageJob(created.state, created.plan, { ports: world.ports });
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "generation_failed");
  assert.ok(state.error?.refId && state.error.refId.length > 0, "carries a short reference id");
  assert.ok(!JSON.stringify(state.error).includes("<!DOCTYPE"), "the raw failure text never enters the state");
  assert.ok(RAFEEQ_JOB_ERROR_AR[state.error.code].length > 0, "the code maps to a fixed Arabic message");
  // failed jobs are terminal no-ops too
  const again = await advanceRafeeqPackageJob(state, created.plan, { ports: world.ports });
  assert.deepEqual(again, state);
});

test("a post-sanitization filename collision fails finalize with the §15 code", async () => {
  const rows = fixtureRows(2);
  const created = createRafeeqPackageJob({ jobId: "job-7", mode: "FULL", previewRows: rows, ...START });
  assert.ok(created.ok);
  const world = fakeWorld();
  let s = created.state;
  while (s.status === "running" && s.cursor < created.plan.products.length) {
    s = await advanceRafeeqPackageJob(s, created.plan, { ports: world.ports, budget: { maxProducts: 10 } });
  }
  // force the §15 condition at finalize time
  s.survivors = s.survivors.map((sv) => ({ ...sv, primaryFilename: "same.jpg" }));
  const done = await advanceRafeeqPackageJob(s, created.plan, { ports: world.ports });
  assert.equal(done.status, "failed");
  assert.equal(done.error?.code, "filename_collision");
});

test("progress reports phases for the status endpoint", async () => {
  const rows = fixtureRows(3);
  const created = createRafeeqPackageJob({ jobId: "job-8", mode: "FULL", previewRows: rows, ...START });
  assert.ok(created.ok);
  const world = fakeWorld();
  assert.equal(jobProgress(created.state, created.plan).phase, "images");
  const { state } = await runToCompletion(created.state, created.plan, world);
  const p = jobProgress(state, created.plan);
  assert.equal(p.phase, "done");
  assert.equal(p.productsDone, 3);
  assert.equal(p.imagesDone, state.entries.length);
});
