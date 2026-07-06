// Weekly plan scheduling — pure, DB-free.
//
// 3 posts a day at varied times: a morning, an afternoon and an evening slot
// (Qatar time, UTC+3), each with a random minute offset inside its window so
// the feed never looks machine-timed. The planner generates 7 days × 3 slots;
// the owner reviews at /social, approves, and the publish cron posts each
// approved row when its scheduled_at passes.

export const QATAR_UTC_OFFSET_H = 3;

/** Daily slot windows in QATAR local time: [startHour, windowMinutes]. */
export const DAY_SLOTS: { startHour: number; startMinute: number; windowMinutes: number; label: string }[] = [
  { startHour: 10, startMinute: 0, windowMinutes: 90, label: "صباحًا" },   // 10:00–11:30
  { startHour: 15, startMinute: 30, windowMinutes: 90, label: "عصرًا" },   // 15:30–17:00
  { startHour: 19, startMinute: 30, windowMinutes: 90, label: "مساءً" },   // 19:30–21:00
];

export const PLAN_DAYS = 7;

/** All (dayOffset, slot) pairs of a week plan, in publish order. */
export function planSlots(days = PLAN_DAYS, perDay = DAY_SLOTS.length): { dayOffset: number; slot: number }[] {
  const out: { dayOffset: number; slot: number }[] = [];
  for (let d = 0; d < days; d++) for (let s = 0; s < perDay; s++) out.push({ dayOffset: d, slot: s });
  return out;
}

/**
 * The UTC Date of (dayOffset, slot) counted from `from` (defaults to now).
 * Day 0 = tomorrow (the plan never schedules into today's already-passing
 * hours). `jitterMinutes` shifts inside the slot window — pass a random value
 * in [0, windowMinutes); deterministic tests pass a fixed one.
 */
export function slotTimeUtc(from: Date, dayOffset: number, slot: number, jitterMinutes: number): Date {
  const s = DAY_SLOTS[Math.max(0, Math.min(DAY_SLOTS.length - 1, slot))];
  const jitter = Math.max(0, Math.min(s.windowMinutes - 1, Math.floor(jitterMinutes)));
  // Local Qatar date of `from`, shifted to tomorrow + dayOffset.
  const local = new Date(from.getTime() + QATAR_UTC_OFFSET_H * 3600_000);
  const base = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1 + dayOffset,
    s.startHour - QATAR_UTC_OFFSET_H, s.startMinute + jitter, 0, 0);
  return new Date(base);
}

/** "الاثنين ٢٠ يوليو" style day heading for a scheduled ISO time (Qatar clock). */
export function qatarDayLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ar", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Qatar" }).format(d);
}

/** "٧:١٥ مساءً" style time label (Qatar clock). */
export function qatarTimeLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ar", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Qatar" }).format(d);
}

/** Qatar-local YYYY-MM-DD key used to group plan cards by day. */
export function qatarDayKey(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const local = new Date(d.getTime() + QATAR_UTC_OFFSET_H * 3600_000);
  return local.toISOString().slice(0, 10);
}
