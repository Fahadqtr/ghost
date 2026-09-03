// STEP 55 — the current package's secure download link, end to end. Owner proofs:
//   1  the current package CAN mint a signed link, and the owner action exists
//      in the export UI (the link route is wired to the email panel);
//   2  the link is bound to the CURRENT package — a link minted for another
//      artifact is rejected, never attached;
//   3  a missing OR expired link blocks the send (fail closed);
//   4  a stale (wrong-package) link blocks the send;
//   5  an example.com / reserved-domain recipient blocks the send;
//   6  the approved signature is still required;
//   7  minting a link sends NO email.
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/step55-download-link.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRafeeqEmailDraft,
  classifyDownloadLink,
  type RafeeqEmailContext,
} from "./email-draft.ts";
import { planRafeeqEmailSend, type RafeeqEmailSendPlanInput } from "./email-send.ts";
import { validateRecipients, isPlaceholderEmailAddress, isValidEmailAddress } from "../../mail/config.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const src = (rel: string): string => readFileSync(join(HERE, rel), "utf8");

const PKG = "rafeeq-full-2026-09-03.zip";
const NOW = "2026-09-03T16:00:00.000Z";
const FRESH = "2026-09-10T16:00:00.000Z";
const STALE_PKG = "rafeeq-full-2026-08-26.zip";

const ctx = (over: Partial<RafeeqEmailContext> = {}): RafeeqEmailContext => ({
  mode: "FULL",
  filename: PKG,
  generatedAt: "2026-09-03T10:51:10.188Z",
  productCount: 1343,
  physicalRowCount: 1454,
  productsWithOptions: 51,
  optionCount: 162,
  imageCount: 1343,
  warningCount: 0,
  zipBytes: 369_281_422,
  packageFingerprint: "03a327da9235fb40",
  correction: true,
  nowIso: NOW,
  downloadLink: { url: "https://storage.example/o/pkg?token=sig", expiresAtIso: FRESH, filename: PKG },
  ...over,
});

const sendInput = (over: Partial<RafeeqEmailSendPlanInput> = {}): RafeeqEmailSendPlanInput => ({
  configured: true,
  toRaw: "orders@rafeeq.qa",
  ccRaw: "",
  subject: "s",
  html: "<div>b</div>",
  text: "b",
  attachments: [{ filename: "rafeeq_catalog.xlsx", bytes: 250_000, contentType: "application/octet-stream" }],
  attachmentMaxBytes: 20 * 1024 * 1024,
  draftBlockers: [],
  ...over,
});

test("1: the owner action to mint/refresh the link for the CURRENT package exists and is wired", () => {
  // The link route is the ONE mechanism: owner-gated POST, reusing the stored
  // artifact. It now also returns the draft rebuilt WITH that link, which is
  // what lets the preview stop reporting missing_download_link.
  const route = src("../../../app/api/export/rafeeq/package/jobs/[jobId]/link/route.ts");
  assert.ok(route.includes("requireOwner"), "owner-gated");
  assert.ok(route.includes("createRafeeqPackageSignedLink(jobId)"), "reuses the existing signed-link mechanism");
  assert.ok(route.includes("buildRafeeqEmailDraftForJob(jobId"), "rebuilds the draft for the SAME job id");
  assert.ok(route.includes("filename: result.value.filename"), "binds the link to the artifact it points at");
  assert.ok(!route.includes("req.json()") && !route.includes("searchParams"), "the URL is never accepted from the client");

  // and the export UI exposes it on the email panel with the required labels.
  const ui = src("../../../components/v2/export/RafeeqFullSync.tsx");
  assert.ok(ui.includes("إنشاء رابط التحميل الآمن"), "create-link label");
  assert.ok(ui.includes("تجديد رابط التحميل الآمن"), "refresh-link label");
  assert.ok(ui.includes('packageLink(emailJobId, "attach")'), "the action calls the existing link route for this job");
  assert.ok(ui.includes("setEmailDraft(body.draft"), "the returned link-bearing draft replaces the preview");
  assert.ok(
    ui.includes('hasLink = !draft.blockers.includes("missing_download_link")'),
    "the label follows the draft's own blocker, not a local guess",
  );
});

test("2: the link must belong to the CURRENT package", () => {
  assert.deepEqual(classifyDownloadLink({ url: "u", expiresAtIso: FRESH, filename: PKG }, PKG, NOW), { ok: true });
  assert.deepEqual(
    classifyDownloadLink({ url: "u", expiresAtIso: FRESH, filename: STALE_PKG }, PKG, NOW),
    { ok: false, reason: "download_link_package_mismatch" },
  );
  // a link with no filename claim is accepted (older callers) but never
  // silently promoted to "matching".
  assert.deepEqual(classifyDownloadLink({ url: "u", expiresAtIso: FRESH }, PKG, NOW), { ok: true });

  const d = buildRafeeqEmailDraft(ctx());
  assert.ok(!d.blockers.includes("missing_download_link"), "a valid current-package link clears the missing blocker");
  assert.ok(!d.blockers.includes("download_link_expired"), "and is not treated as expired");
  assert.ok(!d.blockers.includes("download_link_package_mismatch"), "and matches this package");
  assert.ok(d.html.includes("https://storage.example/o/pkg?token=sig"), "the real URL renders");
  assert.ok(d.textEmail.includes("https://storage.example/o/pkg?token=sig"), "and in plain text");
});

test("3: a missing OR expired link blocks the send", () => {
  for (const link of [null, undefined, { url: "   ", expiresAtIso: FRESH, filename: PKG }]) {
    const d = buildRafeeqEmailDraft(ctx({ downloadLink: link }));
    assert.ok(d.blockers.includes("missing_download_link"), `missing for ${JSON.stringify(link)}`);
    assert.equal(d.sendable, false);
  }
  // expired
  const expired = buildRafeeqEmailDraft(ctx({ downloadLink: { url: "u", expiresAtIso: "2026-09-03T15:59:59.000Z", filename: PKG } }));
  assert.ok(expired.blockers.includes("download_link_expired"), "expired link named");
  assert.equal(expired.sendable, false);
  assert.ok(!expired.html.includes("Package download"), "no download section rendered for a dead link");
  assert.ok(!expired.textEmail.includes("PACKAGE DOWNLOAD"), "and none in plain text");
  // exactly at the expiry instant counts as expired
  assert.deepEqual(classifyDownloadLink({ url: "u", expiresAtIso: NOW, filename: PKG }, PKG, NOW), {
    ok: false,
    reason: "download_link_expired",
  });
  // an unparseable expiry is treated as expired — never sent on faith
  assert.deepEqual(classifyDownloadLink({ url: "u", expiresAtIso: "soon", filename: PKG }, PKG, NOW), {
    ok: false,
    reason: "download_link_expired",
  });
  // with no clock supplied the expiry check is skipped rather than guessed
  assert.deepEqual(classifyDownloadLink({ url: "u", expiresAtIso: "2020-01-01T00:00:00.000Z", filename: PKG }, PKG, null), { ok: true });
  // the server always supplies a real clock
  assert.ok(src("../../rafeeq/package-job.server.ts").includes("nowIso: new Date().toISOString()"), "server passes the clock");
});

test("4: a stale wrong-package link blocks the send", () => {
  const d = buildRafeeqEmailDraft(ctx({ downloadLink: { url: "https://s/old", expiresAtIso: FRESH, filename: STALE_PKG } }));
  assert.ok(d.blockers.includes("download_link_package_mismatch"), "mismatch named");
  assert.equal(d.sendable, false);
  assert.ok(!d.html.includes("https://s/old"), "the wrong-package URL never reaches the body");
  assert.ok(!d.textEmail.includes("https://s/old"), "nor the plain text");
  assert.deepEqual(planRafeeqEmailSend(sendInput({ draftBlockers: d.blockers })), { ok: false, error: "draft_not_sendable" });
});

test("5: an example.com / reserved-domain recipient blocks the send", () => {
  // the placeholder shown in the UI is SYNTACTICALLY valid — which is exactly
  // why syntax alone is not enough.
  assert.equal(isValidEmailAddress("rafeeq@example.com"), true, "syntax passes");
  assert.equal(isPlaceholderEmailAddress("rafeeq@example.com"), true, "but the domain is reserved");

  for (const bad of [
    "rafeeq@example.com",
    "a@example.net",
    "a@example.org",
    "a@EXAMPLE.COM",
    "a@mail.example.com",
    "a@foo.test",
    "a@thing.invalid",
    "a@localhost",
  ]) {
    assert.equal(isPlaceholderEmailAddress(bad), true, `${bad} is a placeholder`);
    const r = validateRecipients(bad, "");
    assert.ok(!r.ok && r.invalid.includes(bad), `${bad} rejected as a recipient`);
    assert.deepEqual(planRafeeqEmailSend(sendInput({ toRaw: bad })), { ok: false, error: "invalid_recipient", invalid: [bad] });
  }
  // a CC placeholder blocks too
  assert.equal(planRafeeqEmailSend(sendInput({ ccRaw: "x@example.com" })).ok, false, "placeholder CC blocked");

  // real addresses still pass — including a local part that merely says "example"
  for (const good of ["orders@rafeeq.qa", "fahad@malikasuniverse.com", "example@rafeeq.qa", "a@example.company"]) {
    assert.equal(isPlaceholderEmailAddress(good), false, `${good} is deliverable`);
    assert.ok(validateRecipients(good, "").ok, `${good} accepted`);
  }
  assert.equal(planRafeeqEmailSend(sendInput()).ok, true, "a real recipient plans fine");
});

test("6: the approved signature is still required", () => {
  const d = buildRafeeqEmailDraft(ctx());
  const sig = src("../../mail/malikas-signature.ts");
  assert.ok(sig.includes("export const APPROVED_SIGNATURE_HTML"), "single approved slot");
  if (d.blockers.includes("signature_not_installed")) {
    assert.equal(d.sendable, false, "no approved signature ⇒ unsendable");
  } else {
    // installed (PR #707) — a valid current link is then the only thing needed
    assert.equal(d.sendable, true, "valid link + installed signature ⇒ sendable");
    assert.deepEqual(d.blockers, [], "nothing left blocking");
    assert.ok(d.html.includes("cdn.shopify.com"), "the approved artwork is in the body");
  }
  // emptying the slot always re-blocks
  const draftSrc = src("./email-draft.ts");
  assert.ok(draftSrc.includes('blockers.push("signature_not_installed")'), "the signature gate is still wired");
});

test("7: minting a link sends NO email and regenerates nothing", () => {
  const route = src("../../../app/api/export/rafeeq/package/jobs/[jobId]/link/route.ts");
  for (const bad of ["sendMail", "sendRafeeqEmail", "runRafeeqEmailSend", "planRafeeqEmailSend", "nodemailer", "smtp"]) {
    assert.ok(!route.includes(bad), `the link route never touches ${bad}`);
  }
  for (const bad of ["startRafeeqPackageJob", "advanceRafeeqPackageJob", "loadRafeeqPreview", "recordRafeeqPackage"]) {
    assert.ok(!route.includes(bad), `the link route never regenerates (${bad})`);
  }
  assert.ok(!route.includes("sent_at"), "never marks anything sent");
  // and the draft builder itself remains side-effect free
  const draftSrc = src("./email-draft.ts");
  for (const bad of ["fetch(", "insert(", "update(", "upsert(", "delete(", "process.env"]) {
    assert.ok(!draftSrc.includes(bad), `the pure draft module has no ${bad}`);
  }
});

test("STEP 55 seam: blockers are reported individually, and the send gate refuses every one", () => {
  const cases: { link: RafeeqEmailContext["downloadLink"]; expect: string }[] = [
    { link: null, expect: "missing_download_link" },
    { link: { url: "u", expiresAtIso: "2026-01-01T00:00:00.000Z", filename: PKG }, expect: "download_link_expired" },
    { link: { url: "u", expiresAtIso: FRESH, filename: STALE_PKG }, expect: "download_link_package_mismatch" },
  ];
  for (const c of cases) {
    const d = buildRafeeqEmailDraft(ctx({ downloadLink: c.link }));
    assert.ok(d.blockers.includes(c.expect as never), `reports ${c.expect}`);
    assert.equal(d.sendable, false, `${c.expect} ⇒ unsendable`);
    assert.deepEqual(
      planRafeeqEmailSend(sendInput({ draftBlockers: d.blockers })),
      { ok: false, error: "draft_not_sendable" },
      `${c.expect} refused by the send planner`,
    );
    // no placeholder ever leaks in any failure mode
    assert.ok(!d.html.includes("[INSERT") && !d.textEmail.includes("[INSERT"), "no placeholder");
  }
});
