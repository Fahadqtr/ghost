// Pure iCalendar (.ics) builder for the tasks feed — subscribe to it from
// TickTick / Google Calendar / Apple Calendar. DB-free so it can be unit-tested.
// Each task with a due date becomes an all-day VEVENT.

export interface IcsTask {
  id: string;
  title: string;
  description?: string | null;
  assignedName?: string | null;
  priority?: "low" | "normal" | "high" | null;
  dueDate?: string | null;   // YYYY-MM-DD
  status?: "open" | "in_progress" | "done" | null;
}

/** Escape a value for an ICS text field (RFC 5545). */
export function icsEscape(v: unknown): string {
  return String(v ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** YYYY-MM-DD → YYYYMMDD (ICS DATE). Returns "" if not a valid date. */
export function icsDate(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ""));
  return m ? `${m[1]}${m[2]}${m[3]}` : "";
}

/** Next calendar day as ICS DATE (all-day DTEND is exclusive). */
export function icsDatePlusOne(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ""));
  if (!m) return "";
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10).replace(/-/g, "");
}

/** Fold a content line to ≤75 octets with CRLF + space continuations (RFC 5545). */
export function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const out: string[] = [];
  let s = line;
  out.push(s.slice(0, 75));
  s = s.slice(75);
  while (s.length > 74) { out.push(" " + s.slice(0, 74)); s = s.slice(74); }
  if (s.length) out.push(" " + s);
  return out.join("\r\n");
}

const PRIORITY_ICS: Record<string, number> = { high: 1, normal: 5, low: 9 };
const PRIORITY_AR: Record<string, string> = { high: "عالية", normal: "عادية", low: "منخفضة" };
const STATUS_AR: Record<string, string> = { open: "مفتوحة", in_progress: "قيد التنفيذ", done: "منجزة" };

export interface IcsOptions {
  stamp: string;            // DTSTAMP, e.g. "20260715T190000Z" (injected → pure)
  calName?: string;
  openOnly?: boolean;       // drop done tasks
  uidDomain?: string;
}

/** Build the full VCALENDAR text for the given tasks. */
export function buildTaskIcs(tasks: IcsTask[], opts: IcsOptions): string {
  const domain = opts.uidDomain || "malika-tasks";
  const name = opts.calName || "Malika Tasks";
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Malika//Tasks//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(name)}`,
    "X-WR-TIMEZONE:Asia/Qatar",
  ];
  for (const t of tasks ?? []) {
    const date = icsDate(String(t.dueDate || ""));
    if (!date) continue;                                   // no due date → skip
    if (opts.openOnly && t.status === "done") continue;
    const who = String(t.assignedName || "").trim();
    const done = t.status === "done";
    const summary = `${done ? "✓ " : ""}${String(t.title || "مهمة").trim()}${who ? ` — ${who}` : ""}`;
    const desc = [
      String(t.description || "").trim(),
      `الحالة: ${STATUS_AR[String(t.status)] ?? "مفتوحة"}`,
      `الأولوية: ${PRIORITY_AR[String(t.priority)] ?? "عادية"}`,
      who ? `المكلَّف: ${who}` : "",
    ].filter(Boolean).join("\\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsEscape(t.id)}@${domain}`,
      `DTSTAMP:${opts.stamp}`,
      `DTSTART;VALUE=DATE:${date}`,
      `DTEND;VALUE=DATE:${icsDatePlusOne(String(t.dueDate))}`,
      foldLine(`SUMMARY:${icsEscape(summary)}`),
      foldLine(`DESCRIPTION:${desc}`),
      `PRIORITY:${PRIORITY_ICS[String(t.priority)] ?? 5}`,
      `STATUS:${done ? "COMPLETED" : "CONFIRMED"}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
