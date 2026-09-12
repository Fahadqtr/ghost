// STEP RAFEEQ 05 — why the owner's browser upload returned 403 on create.
//
// The screen added in STEP RAFEEQ 03 failed instantly with tus_create_failed_403
// against the same bucket the server uploads to every day. The archive was not
// the problem: 92,466,287 bytes, sha256 2032021b…, verified before the picker
// ever saw it.
//
// The browser client had been written separately from lib/storage/tus.server.ts
// and sent:
//
//     tus-resumable, x-signature, apikey
//
// against the server's proven:
//
//     Authorization, apikey, tus-resumable, x-upsert
//
// Storage authorizes on the BEARER token. With no Authorization header the
// request is not "signed but unauthenticated" — it is anonymous, and
// storage.objects carries RLS with ZERO policies, so an anonymous write to a
// private bucket is refused 403 before the signature is considered at all.
//
// The missing x-upsert is the STEP 85J defect a second time: it would not have
// shown as a 403, it would have shown as 409 on every PATCH after a create that
// looked fine. Both headers now come from one module.
//
// node --conditions=react-server --experimental-strip-types --test lib/storage/tus-protocol.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  tusUploadHeaders, tusUploadMetadata, tusBase64, tusEndpoint,
  TUS_RESUMABLE_VERSION, TUS_CHUNK_BYTES, TUS_PATCH_CONTENT_TYPE,
} from "./tus-protocol.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SERVER_TUS = "lib/storage/tus.server.ts";
// STEP RAFEEQ 06 — the browser TUS client is GONE. Presigned resumable was
// refused 403 on create every time: @supabase/storage-js 2.110.0 implements no
// resumable protocol, and the deployed storage does not honour a signed token
// on that endpoint. The owner upload now uses the SDK's uploadToSignedUrl, so
// this module has one caller again — the server — and these tests guard it.
const UPLOAD_UI = "app/(v2)/v2/operations/channels/rafeeq-package/RafeeqPackageUpload.tsx";
const TICKET_SERVER = "lib/rafeeq/package-upload.server.ts";
const PROTOCOL = "lib/storage/tus-protocol.ts";

// ── the header that was missing ─────────────────────────────────────────────

test("1. every request carries Authorization — the 403 was its absence", () => {
  const h = tusUploadHeaders({ authToken: "TOKEN", apiKey: "KEY" });
  assert.equal(h.Authorization, "Bearer TOKEN");
  assert.equal(h.apikey, "KEY");
});

test("2. every request carries x-upsert — the STEP 85J defect, not repeated", () => {
  assert.equal(tusUploadHeaders({ authToken: "t", apiKey: "k" })["x-upsert"], "true");
  assert.equal(tusUploadHeaders({ authToken: "t", apiKey: "k", signature: "s" })["x-upsert"], "true");
});

test("3. the signature rides ALONGSIDE the bearer, never instead of it", () => {
  const h = tusUploadHeaders({ authToken: "PUBLIC", apiKey: "PUBLIC", signature: "SCOPED" });
  assert.equal(h["x-signature"], "SCOPED");
  assert.equal(h.Authorization, "Bearer PUBLIC", "dropping this is exactly what produced 403");
  assert.equal(h["tus-resumable"], TUS_RESUMABLE_VERSION);
});

test("4. no signature header at all when there is no signature", () => {
  for (const sig of [undefined, null, ""]) {
    const h = tusUploadHeaders({ authToken: "t", apiKey: "k", signature: sig });
    assert.equal("x-signature" in h, false, `must omit for ${JSON.stringify(sig)}`);
  }
});

test("5. the server's header set is byte-for-byte what it was before the move", () => {
  const K = "SERVICE";
  assert.deepEqual(tusUploadHeaders({ authToken: K, apiKey: K }), {
    Authorization: `Bearer ${K}`,
    apikey: K,
    "tus-resumable": "1.0.0",
    "x-upsert": "true",
  });
});

// ── one implementation, not two ─────────────────────────────────────────────

test("6. the server transport takes its headers from this module", () => {
  const src = code(SERVER_TUS);
  assert.match(src, /tusUploadHeaders\(/, "must not hand-roll headers");
  assert.equal(/"tus-resumable":\s*"1\.0\.0"/.test(src), false,
    "must not restate the protocol version");
});

test("7. it writes no upload-metadata or patch content type of its own", () => {
  const src = code(SERVER_TUS);
  assert.match(src, /tusUploadMetadata\(/);
  assert.equal(src.includes("application/offset+octet-stream"), false,
    "must use TUS_PATCH_CONTENT_TYPE");
  assert.equal(TUS_PATCH_CONTENT_TYPE, "application/offset+octet-stream");
});

test("8. no browser code speaks this protocol any more", () => {
  const ui = code(UPLOAD_UI);
  assert.equal(ui.includes("tus"), false, "the owner page uses uploadToSignedUrl");
  assert.equal(ui.includes("x-signature"), false);
  assert.match(ui, /uploadToSignedUrl\(/, "the SDK's own signed upload");
});

test("9. the endpoint helper is still correct for the server that uses it", () => {
  assert.equal(tusEndpoint("https://x.supabase.co"), "https://x.supabase.co/storage/v1/upload/resumable");
  assert.equal(tusEndpoint("https://x.supabase.co/"), "https://x.supabase.co/storage/v1/upload/resumable",
    "a trailing slash must not produce a double slash");
  // the ticket no longer ships an endpoint at all: the SDK knows its own
  assert.equal(code(TICKET_SERVER).includes("tusEndpoint"), false);
});

// ── metadata encoding ───────────────────────────────────────────────────────

test("10. base64 matches the platform encoder exactly, including non-ASCII", () => {
  for (const v of ["rafeeq-packages", "application/zip", "3600", "", "a", "ab", "abc",
    "uploads/2026-09-11/2032021bae597fbc/rafeeq-missing-images-156-products.zip", "مرحبا"]) {
    assert.equal(tusBase64(v), Buffer.from(v, "utf8").toString("base64"), `mismatch for ${v}`);
  }
});

test("11. upload-metadata names the bucket and the exact object path", () => {
  const meta = tusUploadMetadata({
    bucket: "rafeeq-packages",
    objectPath: "uploads/2026-09-11/2032021bae597fbc/rafeeq-missing-images-156-products.zip",
    contentType: "application/zip",
  });
  const parts = meta.split(",");
  assert.equal(parts.length, 4);
  assert.equal(parts[0], `bucketName ${tusBase64("rafeeq-packages")}`);
  assert.equal(parts[1],
    `objectName ${tusBase64("uploads/2026-09-11/2032021bae597fbc/rafeeq-missing-images-156-products.zip")}`);
  assert.equal(parts[2], `contentType ${tusBase64("application/zip")}`);
  assert.equal(parts[3], `cacheControl ${tusBase64("3600")}`);
});

test("12. the chunk size Supabase mandates is stated once", () => {
  assert.equal(TUS_CHUNK_BYTES, 6 * 1024 * 1024);
});

// ── security did not move ───────────────────────────────────────────────────

test("13. this module can never carry a secret — it reads no environment", () => {
  const src = code(PROTOCOL);
  assert.equal(src.includes("process.env"), false);
  assert.equal(src.includes("server-only"), false, "it is imported by the browser on purpose");
  assert.equal(/SERVICE_ROLE/i.test(src), false);
});

test("14. the service key still never reaches the page", () => {
  const ui = code(UPLOAD_UI);
  assert.equal(/SERVICE_ROLE/i.test(ui), false);
  assert.equal(/process\.env/.test(ui), false, "the page reads no environment of its own");
});

test("15. the server still authenticates with the service key, not a signature", () => {
  const src = code(SERVER_TUS);
  assert.match(src, /tusUploadHeaders\(\{ authToken: key, apiKey: key \}\)/);
  assert.equal(src.includes("signature"), false, "the server needs no scoped token");
  assert.match(src, /SUPABASE_SERVICE_ROLE_KEY/, "and reads it from the environment, server-side");
});

test("16. the bucket is still private and the owner gate still stands", () => {
  const all = code(TICKET_SERVER)
    + code("app/api/export/rafeeq/package-upload/ticket/route.ts")
    + code("app/api/export/rafeeq/package-upload/verify/route.ts");
  assert.equal(/getPublicUrl/.test(all), false);
  assert.equal(/public:\s*true/.test(all), false);
  assert.match(code("app/api/export/rafeeq/package-upload/ticket/route.ts"),
    /const owner = await requireOwner\(\);\s*if \(!owner\.ok\) return jsonRes/);
  assert.match(code(TICKET_SERVER), /createSignedUploadUrl\(objectPath/,
    "still one path, still scoped");
});

test("17. the server's own resume is untouched — offsets still come from HEAD", () => {
  const src = code(SERVER_TUS);
  assert.match(src, /method: "HEAD"/);
  assert.match(src, /async tusOffset/);
});
