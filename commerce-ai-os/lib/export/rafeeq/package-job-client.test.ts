// RAFEEQ.PKGJOB — shared client driver tests (pure; fetch stubbed).
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/package-job-client.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_MODE_TO_JOB_MODE,
  readJobResponse,
  rafeeqJobDownloadUrl,
  driveRafeeqPackageJob,
  type RafeeqJobStatus,
} from "./package-job-client.ts";

function status(over: Partial<RafeeqJobStatus> = {}): RafeeqJobStatus {
  return {
    jobId: "job-1", status: "running", phase: "images",
    productsDone: 0, productsTotal: 3, imagesDone: 0, bytesDone: 0,
    artifact: null, packageRecorded: false, error: null,
    ...over,
  };
}
const jsonRes = (body: unknown, ok = true) =>
  new Response(JSON.stringify(body), { status: ok ? 200 : 503, headers: { "Content-Type": "application/json" } });

test("the legacy→job mode mapping is explicit and deterministic: ONLY all → full", () => {
  assert.deepEqual(LEGACY_MODE_TO_JOB_MODE, { all: "full" });
  assert.equal(LEGACY_MODE_TO_JOB_MODE["new"], undefined, "subset modes are never routed to the full-catalog job");
  assert.equal(LEGACY_MODE_TO_JOB_MODE["selected"], undefined);
});

test("readJobResponse never interprets a non-JSON body (HTML error pages map to the fixed network code)", async () => {
  const html = new Response("<!DOCTYPE html><h1>A server error occurred</h1>", {
    status: 500, headers: { "Content-Type": "text/html" },
  });
  const r = await readJobResponse(html);
  assert.deepEqual(r, { ok: false, code: "network", refId: null });
});

test("readJobResponse passes structured error codes through and parses ok statuses", async () => {
  const err = await readJobResponse(jsonRes({ error: "jobs_unavailable", message_ar: "…" }, false));
  assert.deepEqual(err, { ok: false, code: "jobs_unavailable", refId: null });
  const ok = await readJobResponse(jsonRes(status({ status: "complete", phase: "done" })));
  assert.ok(ok.ok && ok.value.status === "complete");
});

test("driveRafeeqPackageJob: start → steps → complete, reporting progress each round", async () => {
  const calls: { url: string; method?: string; body?: string }[] = [];
  const script = [
    jsonRes(status({ productsDone: 0 })),
    jsonRes(status({ productsDone: 2 })),
    jsonRes(status({ status: "complete", phase: "done", productsDone: 3, artifact: { filename: "z.zip", totalBytes: 9 } })),
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: typeof init?.body === "string" ? init.body : undefined });
    return script.shift()!;
  }) as typeof fetch;
  try {
    const progress: number[] = [];
    const done = await driveRafeeqPackageJob("full", (s) => progress.push(s.productsDone));
    assert.ok(done.ok);
    assert.equal(done.value.artifact?.filename, "z.zip");
    assert.deepEqual(progress, [0, 2], "progress reported before every step");
    assert.equal(calls[0].url, "/api/export/rafeeq/package/jobs", "generation ALWAYS begins at the idempotent start endpoint");
    assert.equal(calls[0].body, JSON.stringify({ mode: "full" }), "the job mode is explicit");
    assert.ok(calls.slice(1).every((c) => c.url === "/api/export/rafeeq/package/jobs/job-1" && c.method === "POST"), "steps drive the same job");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a retry re-enters through the same idempotent start — the server resumes the live job (no duplicates)", async () => {
  const startUrls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    startUrls.push(String(url));
    // the server returns the SAME live job on every start — already complete here
    return jsonRes(status({ status: "complete", phase: "done" }));
  }) as typeof fetch;
  try {
    const first = await driveRafeeqPackageJob("full", () => {});
    const retry = await driveRafeeqPackageJob("full", () => {});
    assert.ok(first.ok && retry.ok);
    assert.equal(retry.value.jobId, first.value.jobId, "the retry resumed the same job id");
    assert.ok(startUrls.every((u) => u === "/api/export/rafeeq/package/jobs"), "no other creation path exists");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a failed job surfaces its structured {code, refId} — never raw text", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonRes(status({ status: "failed", phase: "failed", error: { code: "filename_collision", refId: "abc-p1-c2" } }))) as typeof fetch;
  try {
    const r = await driveRafeeqPackageJob("full", () => {});
    assert.deepEqual(r, { ok: false, code: "filename_collision", refId: "abc-p1-c2" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the download URL targets the streamed artifact route", () => {
  assert.equal(rafeeqJobDownloadUrl("j-9"), "/api/export/rafeeq/package/jobs/j-9/download");
});
