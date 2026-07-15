// Pure helpers for the Google Calendar task sync. DB/API/crypto-free so they can
// be unit-tested: map a staff task → a Calendar event body, parse the service
// account JSON, and build the JWT claim set for the service-account token flow.

export interface GcalTaskLite {
  id: string;
  title: string;
  description?: string | null;
  assignedName?: string | null;
  priority?: "low" | "normal" | "high" | null;
  dueDate?: string | null;   // YYYY-MM-DD (all-day)
  status?: "open" | "in_progress" | "done" | null;
  createdBy?: string | null;
}

/** Add one day to a YYYY-MM-DD date (Google all-day events have an EXCLUSIVE end). */
export function nextDay(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ""));
  if (!m) return dateStr;
  // Work in UTC to avoid TZ drift; we only care about the calendar date.
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Google colorId by priority (11 = tomato/red, 5 = banana/yellow, 8 = graphite). */
export function priorityColorId(priority?: string | null, done?: boolean): string {
  if (done) return "8"; // graphite — muted for completed
  switch (priority) {
    case "high": return "11";
    case "low": return "8";
    default: return "5"; // normal
  }
}

const PRIORITY_AR: Record<string, string> = { high: "عالية", normal: "عادية", low: "منخفضة" };
const STATUS_AR: Record<string, string> = { open: "مفتوحة", in_progress: "قيد التنفيذ", done: "منجزة" };

/** Build the Calendar event body for a task (all-day on its due date). */
export function taskToEvent(task: GcalTaskLite): Record<string, unknown> {
  const done = task.status === "done";
  const who = String(task.assignedName || "").trim();
  const title = String(task.title || "").trim() || "مهمة";
  const summary = `${done ? "✓ " : ""}${title}${who ? ` — ${who}` : ""}`;
  const lines = [
    String(task.description || "").trim(),
    `الحالة: ${STATUS_AR[String(task.status)] ?? "مفتوحة"}`,
    `الأولوية: ${PRIORITY_AR[String(task.priority)] ?? "عادية"}`,
    who ? `المكلَّف: ${who}` : "لكل الموظفين",
  ].filter(Boolean);
  const start = String(task.dueDate || "");
  return {
    summary,
    description: lines.join("\n"),
    start: { date: start },
    end: { date: nextDay(start) },
    colorId: priorityColorId(task.priority, done),
    // useDefault reminders → respect the calendar owner's notification settings.
    reminders: { useDefault: true },
    // Tag the event so it can always be traced back to its task.
    extendedProperties: { private: { malikaTaskId: String(task.id), source: "malika-tasks" } },
    // Completed tasks are dimmed via transparency (shown as free, not busy).
    transparency: done ? "transparent" : "opaque",
  };
}

/** Parse a Google service-account JSON (client_email + private_key). Tolerant of
 *  a raw JSON string or an already-parsed object; normalises escaped newlines. */
export function parseServiceAccount(raw: string | undefined | null):
  { clientEmail: string; privateKey: string } | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let obj: any = null;
  try { obj = JSON.parse(s); } catch { obj = null; }
  if (!obj || typeof obj !== "object") return null;
  const clientEmail = String(obj.client_email || obj.clientEmail || "").trim();
  let privateKey = String(obj.private_key || obj.privateKey || "");
  // Env-stored keys often carry literal "\n" instead of real newlines.
  privateKey = privateKey.replace(/\\n/g, "\n").trim();
  if (!clientEmail || !/BEGIN PRIVATE KEY/.test(privateKey)) return null;
  return { clientEmail, privateKey };
}

/** base64url encode a string or Buffer-ish byte string. */
export function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Build the signed-JWT header+claims (as a base64url "header.claims" string) for
 *  the service-account token exchange. `nowSec` is unix seconds (injected so the
 *  builder stays pure/testable); the caller signs the returned string. */
export function buildJwtSigningInput(clientEmail: string, nowSec: number, scope = "https://www.googleapis.com/auth/calendar"): string {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: clientEmail,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSec,
    exp: nowSec + 3600,
  };
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
}
