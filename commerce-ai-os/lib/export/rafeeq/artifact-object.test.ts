// RAFEEQ.PKGLINK — artifact-object assembly tests (owner proofs).
// Proves with fake ports: the stored single object is BYTE-IDENTICAL to the
// certified parts (SHA-256 equality), chunking obeys the TUS 6 MiB-multiple
// rule with bounded memory, and EVERY failure path (missing part, upload
// error, size mismatch) records no metadata — which is what blocks emailing
// a broken link.
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/artifact-object.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  assembleRafeeqArtifactObject,
  artifactMetaMatches,
  artifactObjectPath,
  TUS_CHUNK_BYTES,
  TUS_MAX_PATCH_BYTES,
  type RafeeqArtifactObjectPorts,
  type RafeeqArtifactObjectMeta,
} from "./artifact-object.ts";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** certified parts with deliberately awkward sizes (NOT 6 MiB multiples). */
function makeParts(sizes: number[]): { parts: { path: string; bytes: number }[]; data: Map<string, Uint8Array>; all: Uint8Array } {
  const data = new Map<string, Uint8Array>();
  const parts = sizes.map((bytes, i) => {
    const path = `jobs/j1/part-${String(i).padStart(5, "0")}`;
    data.set(path, new Uint8Array(bytes).map((_, k) => (k * 31 + i * 7 + 11) % 256));
    return { path, bytes };
  });
  const total = sizes.reduce((s, n) => s + n, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { all.set(data.get(p.path)!, at); at += p.bytes; }
  return { parts, data, all };
}

interface World {
  ports: RafeeqArtifactObjectPorts;
  patches: { offset: number; length: number }[];
  stored: Uint8Array[];
  meta: RafeeqArtifactObjectMeta | null;
  statSize: number | null | "auto";
}

function world(data: Map<string, Uint8Array>, over: Partial<World> = {}): World {
  const w: World = {
    patches: [],
    stored: [],
    meta: null,
    statSize: "auto",
    ports: {
      readPart: async (path) => data.get(path)?.slice() ?? null,
      tusCreate: async () => "https://tus.example/upload/abc",
      tusPatch: async (_url, offset, chunk) => {
        w.patches.push({ offset, length: chunk.length });
        w.stored.push(chunk.slice());
        return offset + chunk.length;
      },
      statObject: async () =>
        w.statSize === "auto" ? w.stored.reduce((s, c) => s + c.length, 0) : w.statSize,
      writeMeta: async (m) => { w.meta = m; return true; },
    },
    ...over,
  };
  return w;
}

const MiB = 1024 * 1024;

test("stored object bytes === certified parts bytes, and recorded SHA-256 === SHA-256 of the completed package", async () => {
  const { parts, data, all } = makeParts([7 * MiB + 123, 5 * MiB + 1, 13 * MiB + 77, 991]);
  const w = world(data);
  const res = await assembleRafeeqArtifactObject(
    { jobId: "j1", filename: "rafeeq-full-x.zip", parts, totalBytes: all.length, nowIso: "2026-08-26T18:00:00.000Z" },
    w.ports,
  );
  assert.ok(res.ok, "assembly succeeds");
  const uploaded = new Uint8Array(all.length);
  let at = 0;
  for (const c of w.stored) { uploaded.set(c, at); at += c.length; }
  assert.equal(sha256(uploaded), sha256(all), "uploaded byte stream is EXACTLY the certified concatenation");
  assert.equal(res.meta.sha256, sha256(all), "recorded hash IS the certified package hash");
  assert.equal(res.meta.bytes, all.length);
  assert.equal(res.meta.objectPath, artifactObjectPath("j1", "rafeeq-full-x.zip"));
  assert.equal(res.meta.partCount, 4);
  assert.ok(artifactMetaMatches(res.meta, "rafeeq-full-x.zip", all.length), "meta validates against the completed state");
});

test("TUS chunking: every PATCH except the last is a 6 MiB multiple, capped at 24 MiB, offsets contiguous — memory stays bounded", async () => {
  const { parts, data, all } = makeParts([10 * MiB + 5, 8 * MiB, 3 * MiB + 9]);
  const w = world(data);
  const res = await assembleRafeeqArtifactObject(
    { jobId: "j1", filename: "f.zip", parts, totalBytes: all.length, nowIso: "2026-08-26T18:00:00.000Z" },
    w.ports,
  );
  assert.ok(res.ok);
  let expect = 0;
  for (const [i, p] of w.patches.entries()) {
    assert.equal(p.offset, expect, "offsets are contiguous");
    if (i < w.patches.length - 1) {
      assert.equal(p.length % TUS_CHUNK_BYTES, 0, "non-final PATCH is a 6 MiB multiple");
    }
    assert.ok(p.length <= TUS_MAX_PATCH_BYTES, "PATCH bounded at 24 MiB — the whole ZIP is never in one request");
    expect += p.length;
  }
  assert.equal(expect, all.length, "the full byte count was transferred");
});

test("missing/short part → part_missing and NO metadata is recorded (broken links can never be emailed)", async () => {
  const { parts, data, all } = makeParts([2 * MiB, 2 * MiB]);
  data.delete(parts[1].path);
  const w = world(data);
  const res = await assembleRafeeqArtifactObject(
    { jobId: "j1", filename: "f.zip", parts, totalBytes: all.length, nowIso: "t" },
    w.ports,
  );
  assert.deepEqual(res, { ok: false, error: "part_missing" });
  assert.equal(w.meta, null, "writeMeta was never called");
});

test("upload failure mid-stream → upload_failed, nothing recorded", async () => {
  const { parts, data, all } = makeParts([8 * MiB, 8 * MiB]);
  const w = world(data);
  let calls = 0;
  w.ports.tusPatch = async (_u, offset, chunk) => (++calls === 2 ? null : offset + chunk.length);
  const res = await assembleRafeeqArtifactObject(
    { jobId: "j1", filename: "f.zip", parts, totalBytes: all.length, nowIso: "t" },
    w.ports,
  );
  assert.deepEqual(res, { ok: false, error: "upload_failed" });
  assert.equal(w.meta, null);
});

test("stored-size verification failure → size_mismatch, nothing recorded", async () => {
  const { parts, data, all } = makeParts([1 * MiB]);
  const w = world(data, { statSize: all.length - 1 });
  const res = await assembleRafeeqArtifactObject(
    { jobId: "j1", filename: "f.zip", parts, totalBytes: all.length, nowIso: "t" },
    w.ports,
  );
  assert.deepEqual(res, { ok: false, error: "size_mismatch" });
  assert.equal(w.meta, null);
});

test("artifactMetaMatches rejects stale/foreign metadata (filename, size, malformed hash)", () => {
  const meta: RafeeqArtifactObjectMeta = {
    version: 1, jobId: "j1", objectPath: "artifacts/j1/f.zip", filename: "f.zip",
    bytes: 100, sha256: "a".repeat(64), partCount: 1, uploadedAtIso: "t",
  };
  assert.ok(artifactMetaMatches(meta, "f.zip", 100));
  assert.ok(!artifactMetaMatches(meta, "other.zip", 100), "filename mismatch → reassemble");
  assert.ok(!artifactMetaMatches(meta, "f.zip", 101), "size mismatch → reassemble");
  assert.ok(!artifactMetaMatches({ ...meta, sha256: "nope" }, "f.zip", 100), "malformed hash rejected");
});
