import test from "node:test";
import assert from "node:assert/strict";

import { icsEscape, icsDate, icsDatePlusOne, foldLine, buildTaskIcs } from "./ics-compute.ts";

test("icsEscape escapes backslash, comma, semicolon, newline", () => {
  assert.equal(icsEscape("a, b; c\\d\ne"), "a\\, b\\; c\\\\d\\ne");
});

test("icsDate + icsDatePlusOne handle month/year rollover", () => {
  assert.equal(icsDate("2026-07-15"), "20260715");
  assert.equal(icsDatePlusOne("2026-07-31"), "20260801");
  assert.equal(icsDatePlusOne("2026-12-31"), "20270101");
  assert.equal(icsDate("bad"), "");
});

test("foldLine wraps lines longer than 75 octets with CRLF+space", () => {
  const long = "X".repeat(200);
  const folded = foldLine("DESCRIPTION:" + long);
  assert.ok(folded.includes("\r\n "));
  assert.ok(folded.split("\r\n").every((l) => l.length <= 75));
});

test("buildTaskIcs emits a VEVENT per dated task with all-day start/end", () => {
  const ics = buildTaskIcs(
    [{ id: "t1", title: "تعبئة الرفوف", assignedName: "سارة", priority: "high", dueDate: "2026-07-15", status: "open" }],
    { stamp: "20260715T120000Z" },
  );
  assert.ok(ics.startsWith("BEGIN:VCALENDAR"));
  assert.ok(ics.trimEnd().endsWith("END:VCALENDAR"));
  assert.match(ics, /DTSTART;VALUE=DATE:20260715/);
  assert.match(ics, /DTEND;VALUE=DATE:20260716/);
  assert.match(ics, /UID:t1@malika-tasks/);
  assert.match(ics, /PRIORITY:1/);
});

test("buildTaskIcs skips undated tasks and (when openOnly) completed ones", () => {
  const tasks = [
    { id: "a", title: "no date", dueDate: null, status: "open" as const },
    { id: "b", title: "done", dueDate: "2026-07-15", status: "done" as const },
    { id: "c", title: "open", dueDate: "2026-07-16", status: "open" as const },
  ];
  const open = buildTaskIcs(tasks, { stamp: "20260715T120000Z", openOnly: true });
  assert.ok(!open.includes("UID:a@"));   // no date
  assert.ok(!open.includes("UID:b@"));   // done, excluded
  assert.ok(open.includes("UID:c@"));
  const all = buildTaskIcs(tasks, { stamp: "20260715T120000Z", openOnly: false });
  assert.ok(all.includes("UID:b@"));     // done included with ?all=1
  assert.match(all, /SUMMARY:✓ done/);
});
