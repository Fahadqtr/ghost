// RAFEEQ — download-last artifact selection tests (proofs 17–20 + 24 of the
// post-generation UX request). Pure: the selection semantics the server layer
// applies before its storage-existence check.
//   • the latest COMPLETE job per mode wins;
//   • running / failed / incomplete rows are NEVER download candidates;
//   • rows without a recorded artifact are excluded (the caller then verifies
//     storage per candidate and falls back to the next-newest valid one);
//   • no valid candidate → empty (UI shows the disabled state);
//   • a running job never displaces the previously completed artifact.
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/artifact-selection.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { selectDownloadCandidates, selectHistoryCandidates, type RafeeqJobRowCandidate } from "./artifact-selection.ts";

function row(id: string, over: Partial<RafeeqJobRowCandidate> = {}): RafeeqJobRowCandidate {
  return {
    id,
    mode: "FULL",
    status: "complete",
    createdAt: "2026-08-26T00:00:00.000Z",
    artifactFilename: `rafeeq-full-${id}.zip`,
    artifactBytes: 1000,
    productsTotal: 10,
    imagesDone: 10,
    packageId: null,
    ...over,
  };
}

test("17: the latest COMPLETE job of the mode is the first candidate — per mode, independently", () => {
  const rows = [
    row("f-old", { createdAt: "2026-08-20T00:00:00.000Z" }),
    row("f-new", { createdAt: "2026-08-25T00:00:00.000Z" }),
    row("n-only", { mode: "NEW", createdAt: "2026-08-24T00:00:00.000Z", artifactFilename: "rafeeq-new-n.zip" }),
  ];
  assert.deepEqual(selectDownloadCandidates(rows, "FULL").map((r) => r.id), ["f-new", "f-old"], "FULL: newest first");
  assert.deepEqual(selectDownloadCandidates(rows, "NEW").map((r) => r.id), ["n-only"], "NEW selects only NEW rows");
});

test("18: running, failed and incomplete jobs are never candidates", () => {
  const rows = [
    row("running", { status: "running", createdAt: "2026-08-27T00:00:00.000Z" }),
    row("failed", { status: "failed", createdAt: "2026-08-27T01:00:00.000Z" }),
    row("weird", { status: "planning", createdAt: "2026-08-27T02:00:00.000Z" }),
    row("done", { createdAt: "2026-08-25T00:00:00.000Z" }),
  ];
  assert.deepEqual(selectDownloadCandidates(rows, "FULL").map((r) => r.id), ["done"], "only the complete row survives");
});

test("19: rows without a recorded artifact are excluded; ordering gives the missing-files fallback", () => {
  const rows = [
    row("no-artifact", { createdAt: "2026-08-28T00:00:00.000Z", artifactFilename: null }),
    row("newest-valid", { createdAt: "2026-08-27T00:00:00.000Z" }),
    row("older-valid", { createdAt: "2026-08-26T00:00:00.000Z" }),
  ];
  const ordered = selectDownloadCandidates(rows, "FULL");
  assert.deepEqual(ordered.map((r) => r.id), ["newest-valid", "older-valid"], "artifact-less row is skipped entirely");
  // storage-existence fallback semantics: if the caller finds newest-valid's
  // files missing, the NEXT list entry is the next-newest valid artifact.
  assert.equal(ordered[1].id, "older-valid");
});

test("20: no completed artifact at all → empty (the UI renders the disabled download state)", () => {
  const rows = [
    row("r", { status: "running" }),
    row("f", { status: "failed" }),
    row("na", { artifactFilename: null }),
  ];
  assert.deepEqual(selectDownloadCandidates(rows, "FULL"), []);
  assert.deepEqual(selectDownloadCandidates([], "NEW"), []);
});

test("24: a RUNNING job never displaces the previously completed artifact of its mode", () => {
  const before = [row("prev", { createdAt: "2026-08-25T00:00:00.000Z" })];
  const during = [
    ...before,
    row("live", { status: "running", createdAt: "2026-08-26T09:00:00.000Z", artifactFilename: null }),
  ];
  assert.deepEqual(
    selectDownloadCandidates(during, "FULL"),
    selectDownloadCandidates(before, "FULL"),
    "the download candidate set is identical while a new job runs",
  );
  assert.equal(selectDownloadCandidates(during, "FULL")[0].id, "prev");
});

test("history: both modes, same completeness rules, newest first, limited", () => {
  const rows = [
    row("a", { createdAt: "2026-08-20T00:00:00.000Z" }),
    row("b", { mode: "NEW", createdAt: "2026-08-22T00:00:00.000Z" }),
    row("c", { createdAt: "2026-08-24T00:00:00.000Z" }),
    row("skip-running", { status: "running", createdAt: "2026-08-25T00:00:00.000Z" }),
    row("skip-no-artifact", { createdAt: "2026-08-26T00:00:00.000Z", artifactFilename: null }),
  ];
  assert.deepEqual(selectHistoryCandidates(rows, 10).map((r) => r.id), ["c", "b", "a"]);
  assert.deepEqual(selectHistoryCandidates(rows, 2).map((r) => r.id), ["c", "b"], "limit respected");
  assert.deepEqual(selectHistoryCandidates(rows, 0), [], "zero limit → empty");
});
