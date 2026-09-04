// STEP 58 — the MANUALLY entered Rafeeq recipient propagates, unchanged, from
// the draft field to the confirmation modal to the send payload. Owner proofs:
//   1  a manual recipient entered in the draft reaches the confirmation;
//   2  the confirmation displays exactly that address;
//   3  the send payload carries exactly that address;
//   4  rafeeq@example.com is never substituted;
//   5  any other valid manual recipient propagates identically;
//   6  invalid / reserved-domain recipients stay blocked;
//   7  changing the recipient after the confirmation opened cannot send the
//      stale address.
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/step58-recipient-propagation.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePendingRecipient, normalizeRecipient } from "./send-recipient.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const src = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const UI = src("components/v2/export/RafeeqFullSync.tsx");

/** the address from the production bug report */
const MANUAL = "amina.ariq@gorafeeq.com";
/** the placeholder that was wrongly appearing instead */
const PLACEHOLDER = "rafeeq@example.com";

test("1: a manual recipient entered in the draft reaches the confirmation", () => {
  // the confirmation snapshots the DRAFT's value; nothing else feeds it
  const p = resolvePendingRecipient(MANUAL, MANUAL, "");
  assert.equal(p.pendingTo, MANUAL, "the draft's address is the pending recipient");
  assert.equal(p.stale, false);
  assert.equal(p.valid, true);
  assert.equal(p.canConfirm, true);

  // and the component actually hands the draft value to the modal
  assert.ok(UI.includes("<RafeeqSendModal jobId={emailJobId} recipient={emailTo}"), "the draft recipient is passed in");
  assert.ok(UI.includes("const [snapshotTo] = useState(() => normalizeRecipient(recipient));"), "snapshotted at open");
  // the modal no longer owns a second recipient state
  assert.ok(!UI.includes('const [to, setTo] = useState("")'), "no independent modal recipient state");
  assert.ok(!UI.includes("setTo("), "nothing can reassign a separate recipient");
});

test("2: the confirmation displays exactly the pending recipient", () => {
  assert.ok(
    UI.includes('<input id="rafeeq-send-to" readOnly type="text" dir="ltr" value={pending.pendingTo}'),
    "the To field renders pending.pendingTo, read-only",
  );
  // display and payload read the SAME field of the SAME object
  assert.ok(UI.includes("const pending = resolvePendingRecipient(snapshotTo, recipient, cc);"), "one resolved value");
  assert.equal((UI.match(/pending\.pendingTo/g) ?? []).length >= 2, true, "used for both display and payload");
});

test("3: the send payload carries exactly that address", () => {
  assert.ok(
    UI.includes("body: JSON.stringify({ to: pending.pendingTo, cc, saveRecipient }),"),
    "the POST body sends pending.pendingTo",
  );
  // the value shown and the value sent are the identical expression
  const p = resolvePendingRecipient(MANUAL, MANUAL, "");
  assert.equal(p.pendingTo, MANUAL, "displayed == transmitted");
});

test("4: rafeeq@example.com is NEVER substituted", () => {
  const p = resolvePendingRecipient(MANUAL, MANUAL, "");
  assert.notEqual(p.pendingTo, PLACEHOLDER);
  assert.equal(p.pendingTo, MANUAL);

  // the placeholder is gone from the confirmation entirely — it only ever
  // existed as a placeholder ATTRIBUTE, which read as a value to the owner.
  const modal = UI.slice(UI.indexOf("function RafeeqSendModal"));
  assert.ok(!modal.includes(PLACEHOLDER), "the confirmation carries no example.com placeholder");

  // and the app_settings seeding that made the modal diverge is gone
  assert.ok(!UI.includes("setTo((body as RafeeqSendPreflightVM).savedRecipient"), "no savedRecipient seeding");
  // savedRecipient survives as a read-only hint only
  assert.ok(UI.includes("pf.savedRecipient"), "still shown as a hint when no recipient was entered");

  // an EMPTY draft yields an empty pending recipient — never a fallback
  const empty = resolvePendingRecipient("", "", "");
  assert.equal(empty.pendingTo, "");
  assert.equal(empty.canConfirm, false, "empty cannot confirm");
});

test("5: any other valid manual recipient propagates identically", () => {
  for (const addr of [
    "orders@rafeeq.qa",
    "catalog.team@gorafeeq.com",
    "a.b-c+tag@sub.domain.co.uk",
    "PROCUREMENT@GoRafeeq.com",
  ]) {
    const p = resolvePendingRecipient(addr, addr, "");
    assert.equal(p.pendingTo, addr, `${addr} passes through byte-for-byte`);
    assert.equal(p.canConfirm, true, `${addr} can confirm`);
  }
  // surrounding whitespace is trimmed, the address itself is never rewritten
  const padded = resolvePendingRecipient(`  ${MANUAL}  `, `  ${MANUAL}  `, "");
  assert.equal(padded.pendingTo, MANUAL, "trimmed only");
  assert.equal(normalizeRecipient(`\t${MANUAL}\n`), MANUAL);
  // no lowercasing / rewriting
  assert.equal(resolvePendingRecipient("Amina.Ariq@GoRafeeq.com", "Amina.Ariq@GoRafeeq.com", "").pendingTo, "Amina.Ariq@GoRafeeq.com");
});

test("6: invalid and reserved-domain recipients stay blocked", () => {
  for (const bad of [PLACEHOLDER, "a@example.net", "a@mail.example.com", "a@localhost", "a@thing.invalid", "a@foo.test"]) {
    const p = resolvePendingRecipient(bad, bad, "");
    assert.equal(p.valid, false, `${bad} is invalid`);
    assert.equal(p.canConfirm, false, `${bad} cannot confirm`);
    assert.ok(p.invalid.includes(bad), `${bad} is named as invalid`);
  }
  // malformed addresses too
  for (const bad of ["not-an-email", "@nodomain.com", "spaces in@address.com", ""]) {
    assert.equal(resolvePendingRecipient(bad, bad, "").canConfirm, false, `${JSON.stringify(bad)} cannot confirm`);
  }
  // a reserved-domain CC blocks the send as well
  const badCc = resolvePendingRecipient(MANUAL, MANUAL, PLACEHOLDER);
  assert.equal(badCc.canConfirm, false, "placeholder CC blocks");
  // the send button is gated on canConfirm
  assert.ok(UI.includes("pending.canConfirm && !sending && !sentResult"), "canSend requires canConfirm");
});

test("7: a recipient changed after the confirmation opened cannot be sent", () => {
  // opened on the real address, then the draft was edited underneath
  const drifted = resolvePendingRecipient(MANUAL, "someone.else@gorafeeq.com", "");
  assert.equal(drifted.pendingTo, MANUAL, "the snapshot is what would have been sent");
  assert.equal(drifted.stale, true, "divergence is detected");
  assert.equal(drifted.canConfirm, false, "and the confirmation refuses");

  // even when the NEW address is itself perfectly valid
  assert.equal(resolvePendingRecipient(MANUAL, "valid@gorafeeq.com", "").canConfirm, false);
  // and when the draft is cleared
  assert.equal(resolvePendingRecipient(MANUAL, "", "").canConfirm, false);
  // whitespace-only edits are NOT drift
  assert.equal(resolvePendingRecipient(MANUAL, `  ${MANUAL} `, "").stale, false, "trimming is not a change");

  // the UI surfaces it and tells the owner to rebuild the confirmation
  assert.ok(UI.includes("{pending.stale && ("), "stale state is rendered");
  assert.ok(UI.includes("تغيّر المستلم بعد فتح التأكيد"), "explains the recipient changed after opening");
});

test("STEP 58 seam: one authoritative recipient, and the manual policy is intact", () => {
  // exactly one resolver call in the component, feeding display + payload
  assert.equal((UI.match(/resolvePendingRecipient\(/g) ?? []).length, 1, "one resolution per pending send");
  // the resolver delegates to the SHARED validation — no second rule
  const mod = src("lib/export/rafeeq/send-recipient.ts");
  assert.ok(mod.includes("import { validateRecipients }"), "uses the shared validator");
  // no email-shaped LITERAL is baked in (JSDoc @param tags are not addresses)
  const addressLiterals = mod.match(/["'`][^"'`\s]+@[^"'`\s]+\.[a-z]{2,}["'`]/gi) ?? [];
  assert.deepEqual(addressLiterals, [], "no address literal is hardcoded in the resolver");
  // recipient policy unchanged: nothing here writes app_settings. Scan CODE,
  // not prose — the module's header explains the policy it upholds.
  const modCode = mod.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const bad of ["app_settings", "upsert", "rafeeq_email_recipient", "fetch(", "process.env"]) {
    assert.ok(!modCode.includes(bad), `the resolver never touches ${bad}`);
  }
  // the opt-in save checkbox still exists and is still the owner's choice
  assert.ok(UI.includes("saveRecipient"), "the opt-in save flag is untouched");
});
