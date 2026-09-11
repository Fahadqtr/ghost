// STEP RAFEEQ 03 — putting a ready-made archive into the private bucket.
//
// The 156-image answer to Rafeeq's missing-images request is 92,466,287 bytes.
// The existing package path could not accept it: ensureRafeeqArtifactObject
// assembles the certified parts of a job the app itself ran, and this archive
// was not one. The only other upload route in the app reads the whole body
// with formData() — the shape that meets a platform request limit at 92 MB.
//
// So the bytes go browser → storage directly, on a credential the server mints
// for ONE path after verifying the owner. What follows is what that credential
// is allowed to be, where it may write, and what counts as proof the upload
// actually worked.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/package-upload.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  rafeeqUploadObjectPath,
  sanitizeUploadFilename,
  verifyRafeeqUploadRequest,
  verifyRafeeqUploadedObject,
  RAFEEQ_UPLOAD_BLOCK_AR,
  RAFEEQ_UPLOAD_MAX_BYTES,
  RAFEEQ_UPLOAD_CHUNK_BYTES,
} from "./package-upload.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SERVER = "lib/rafeeq/package-upload.server.ts";
const TICKET_ROUTE = "app/api/export/rafeeq/package-upload/ticket/route.ts";
const VERIFY_ROUTE = "app/api/export/rafeeq/package-upload/verify/route.ts";
const UI = "app/(v2)/v2/operations/channels/rafeeq-package/RafeeqPackageUpload.tsx";
const TUS = "app/(v2)/v2/operations/channels/rafeeq-package/tus-upload.ts";
const PAGE = "app/(v2)/v2/operations/channels/rafeeq-package/page.tsx";

/** The real archive this step exists for. */
const SHA = "2032021bae597fbc2d4e80a2568fc23949f604e6c7af61797baa3523da8e4829";
const NAME = "rafeeq-missing-images-156-products.zip";
const BYTES = 92466287;

// ── where it lands ──────────────────────────────────────────────────────────

test("1. the destination is derived from the archive's own bytes", () => {
  const p = rafeeqUploadObjectPath(SHA, NAME, "2026-09-11T19:00:00.000Z");
  assert.equal(p, `uploads/2026-09-11/${SHA.slice(0, 16)}/${NAME}`);
});

test("2. a manual upload can never land on a generated package", () => {
  const p = rafeeqUploadObjectPath(SHA, NAME, "2026-09-11T19:00:00.000Z");
  assert.ok(p.startsWith("uploads/"), "jobs/ and artifacts/ are untouchable from here");
  assert.equal(p.includes("jobs/"), false);
  assert.equal(p.includes("artifacts/"), false);
});

test("3. the same archive resumes to the same path; a different one cannot collide", () => {
  const a = rafeeqUploadObjectPath(SHA, NAME, "2026-09-11T19:00:00.000Z");
  const again = rafeeqUploadObjectPath(SHA, NAME, "2026-09-11T23:59:00.000Z");
  assert.equal(a, again, "re-uploading the same bytes on the same day resumes, not duplicates");
  const other = rafeeqUploadObjectPath("f".repeat(64), NAME, "2026-09-11T19:00:00.000Z");
  assert.notEqual(a, other, "different bytes, same filename, same day — different object");
});

test("4. a hostile filename cannot escape the prefix", () => {
  // the directory part is DROPPED, not flattened into the name: a path is
  // never a filename here, so there is nothing left to traverse with.
  assert.equal(sanitizeUploadFilename("../../jobs/state.json"), "state.json");
  assert.equal(sanitizeUploadFilename("a/b/c/pkg .zip"), "pkg-.zip");
  assert.equal(sanitizeUploadFilename("..\\..\\windows\\evil.zip"), "evil.zip");
  assert.equal(sanitizeUploadFilename(""), "archive.zip");
  const p = rafeeqUploadObjectPath(SHA, "../../../etc/passwd", "2026-09-11T00:00:00.000Z");
  assert.equal(p.includes(".."), false);
  assert.ok(p.startsWith("uploads/2026-09-11/"));
});

// ── what is refused before a byte moves ─────────────────────────────────────

test("5. the real archive is accepted", () => {
  assert.deepEqual(verifyRafeeqUploadRequest({ filename: NAME, bytes: BYTES, sha256: SHA }), []);
});

test("6. anything that is not a zip is refused", () => {
  assert.ok(verifyRafeeqUploadRequest({ filename: "images.tar", bytes: 10, sha256: SHA })
    .includes("not_a_zip"));
  assert.ok(verifyRafeeqUploadRequest({ filename: "notes.xlsx", bytes: 10, sha256: SHA })
    .includes("not_a_zip"));
  // case is not a loophole
  assert.deepEqual(verifyRafeeqUploadRequest({ filename: "PKG.ZIP", bytes: 10, sha256: SHA }), []);
});

test("7. empty and oversize are refused, and the 92 MB case is neither", () => {
  assert.ok(verifyRafeeqUploadRequest({ filename: NAME, bytes: 0, sha256: SHA }).includes("empty_file"));
  assert.ok(verifyRafeeqUploadRequest({ filename: NAME, bytes: RAFEEQ_UPLOAD_MAX_BYTES + 1, sha256: SHA })
    .includes("too_large"));
  assert.ok(BYTES < RAFEEQ_UPLOAD_MAX_BYTES);
});

test("8. a malformed fingerprint is refused — the path is built from it", () => {
  for (const bad of ["", "xyz", SHA.slice(0, 63), SHA.toUpperCase() + "a"]) {
    assert.ok(verifyRafeeqUploadRequest({ filename: NAME, bytes: BYTES, sha256: bad })
      .includes("sha256_malformed"), `must refuse ${JSON.stringify(bad.slice(0, 12))}`);
  }
});

// ── what counts as proof it worked ──────────────────────────────────────────

test("9. a missing object is reported as missing, not as a size problem", () => {
  assert.deepEqual(verifyRafeeqUploadedObject(null, BYTES), ["object_missing"]);
});

test("10. a short object blocks — an interrupted upload is not a success", () => {
  assert.deepEqual(verifyRafeeqUploadedObject(BYTES - 1, BYTES), ["size_mismatch"]);
  assert.deepEqual(verifyRafeeqUploadedObject(BYTES, BYTES), []);
});

test("11. a hash is only compared when the bytes were actually read back", () => {
  // absent evidence never passes as a match
  assert.deepEqual(verifyRafeeqUploadedObject(BYTES, BYTES, null, SHA), []);
  assert.deepEqual(verifyRafeeqUploadedObject(BYTES, BYTES, SHA, SHA), []);
  assert.deepEqual(verifyRafeeqUploadedObject(BYTES, BYTES, "a".repeat(64), SHA), ["sha256_mismatch"]);
  // case-insensitive, because hex casing is not a difference in content
  assert.deepEqual(verifyRafeeqUploadedObject(BYTES, BYTES, SHA.toUpperCase(), SHA), []);
});

test("12. every block has an owner-language message", () => {
  for (const k of ["not_a_zip", "empty_file", "too_large", "sha256_malformed",
    "size_mismatch", "sha256_mismatch", "object_missing"] as const) {
    assert.ok(typeof RAFEEQ_UPLOAD_BLOCK_AR[k] === "string" && RAFEEQ_UPLOAD_BLOCK_AR[k].length > 0);
  }
});

// ── the credential ──────────────────────────────────────────────────────────

test("13. the server mints a SCOPED upload token, never the service key", () => {
  const src = code(SERVER);
  assert.match(src, /createSignedUploadUrl\(objectPath/, "one path, one credential");
  // the ticket handed to the browser carries the public key only
  assert.match(src, /apiKey: process\.env\.NEXT_PUBLIC_SUPABASE_ANON_KEY|const apiKey = process\.env\.NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  assert.equal(src.includes("SUPABASE_SERVICE_ROLE"), false, "no service key in this module's text");
});

test("14. the browser never receives a service key, and the page never reads env", () => {
  const ui = code(UI) + code(TUS);
  assert.equal(/SERVICE_ROLE/i.test(ui), false);
  assert.equal(/process\.env/.test(ui), false, "the client takes everything from the ticket");
  assert.match(code(TUS), /"x-signature": o\.token/, "the scoped token is the credential");
});

test("15. the bytes never pass through a server route", () => {
  for (const rel of [TICKET_ROUTE, VERIFY_ROUTE]) {
    const src = code(rel);
    assert.equal(src.includes("formData"), false, `${rel} must not read a file body`);
    assert.equal(src.includes("arrayBuffer"), false, `${rel} must not read bytes`);
  }
  // and the client uploads to Supabase's endpoint, not to our own origin
  assert.match(code(UI), /endpoint: ticket\.endpoint/);
});

test("16. both routes are owner-gated before anything else happens", () => {
  for (const rel of [TICKET_ROUTE, VERIFY_ROUTE]) {
    const src = code(rel);
    assert.match(src, /const owner = await requireOwner\(\);\s*if \(!owner\.ok\) return jsonRes/,
      `${rel} must refuse a non-owner first`);
  }
  assert.match(code(PAGE), /await requireOwner\(\)/, "the screen itself is gated too");
});

// ── resume, progress, and the link ──────────────────────────────────────────

test("17. an interrupted upload resumes from the SERVER's offset", () => {
  const src = code(TUS);
  assert.match(src, /method: "HEAD"/, "the resume point is asked for, not assumed");
  assert.match(src, /offset = await offsetOf\(uploadUrl, o\)/);
  assert.match(src, /"upload-offset": String\(offset\)/);
  assert.equal(RAFEEQ_UPLOAD_CHUNK_BYTES, 6 * 1024 * 1024, "Supabase requires exactly 6 MB chunks");
});

test("18. progress is reported from confirmed bytes, and the upload can be stopped", () => {
  assert.match(code(TUS), /o\.onProgress\?\.\(offset, total\)/);
  assert.match(code(UI), /abortRef\.current\?\.abort\(\)/);
  assert.match(code(UI), /await tusUpload\(opts, resumeRef\.current\)/,
    "a retry continues the same upload URL");
  // the URL is captured when it is CREATED, not when the upload succeeds —
  // otherwise a failed attempt loses the only handle that could resume it
  assert.match(code(TUS), /o\.onUploadUrl\?\.\(uploadUrl\)/);
  assert.match(code(UI), /onUploadUrl: \(u\) => \{ resumeRef\.current = u; setCanResume\(true\); \}/);
  assert.match(code(UI), /canResume \? "/, "and the label reads state, never a ref during render");
});

test("19. the link is signed for 7 days and its expiry is shown", () => {
  const src = code(SERVER);
  assert.match(src, /RAFEEQ_LINK_TTL_SECONDS/);
  assert.match(src, /createSignedUrl\(objectPath, expiresInSeconds, \{ download: filename \}\)/);
  assert.match(src, /expiresAtIso: new Date\(Date\.now\(\) \+ expiresInSeconds \* 1000\)\.toISOString\(\)/);
  assert.match(code(UI), /link\.expiresAtIso/);
});

test("20. the bucket is never made public", () => {
  const all = code(SERVER) + code(TICKET_ROUTE) + code(VERIFY_ROUTE) + code(UI);
  assert.equal(/getPublicUrl/.test(all), false, "a private bucket stays private");
  assert.equal(/public:\s*true/.test(all), false);
});

test("21. the link is proven by downloading it with no credentials", () => {
  const ui = code(UI);
  assert.match(ui, /await fetch\(issued\.url, \{ cache: "no-store" \}\)/,
    "no Authorization header — exactly what Rafeeq will experience");
  assert.match(ui, /backSha === sha/, "and the bytes that come back are hashed");
  assert.match(ui, /setRoundTrip\(/);
});

// ── blast radius ────────────────────────────────────────────────────────────

test("22. nothing here sends mail, deletes, or touches the catalogue", () => {
  const all = code(SERVER) + code(TICKET_ROUTE) + code(VERIFY_ROUTE) + code(UI) + code(TUS);
  for (const forbidden of ["sendMailViaSmtp", ".remove(", "lifecycle_state",
    'from("products")', "external_channel_listings", "delete("]) {
    assert.equal(all.includes(forbidden), false, `must not ${forbidden}`);
  }
});

test("23. existing generated packages are never read or replaced by this path", () => {
  const src = code(SERVER);
  assert.equal(src.includes("ensureRafeeqArtifactObject"), false);
  assert.equal(src.includes("assembleRafeeqArtifactObject"), false);
  assert.match(src, /rafeeqUploadObjectPath/, "it only ever writes under uploads/");
});
