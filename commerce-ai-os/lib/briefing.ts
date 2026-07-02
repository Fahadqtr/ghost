// Pure composer for Malak's morning briefing. Turns the store pulse (catalog
// counts + prioritized alerts + sales) into a structured briefing AND a clean,
// speakable Arabic sentence in Malak's Gulf voice. No DB, no I/O — the data is
// gathered by the caller (app/api/malak/briefing) and passed in, so this stays
// trivially unit-testable.

export type BriefingSeverity = "high" | "med" | "low";

/** One prioritized store-pulse item (mapped from getNotifications). */
export interface BriefingAlert {
  ar: string;               // plain Arabic text, e.g. "3 منتجات نافدة من المخزون"
  severity: BriefingSeverity;
}

export interface BriefingSales {
  units: number;
  revenue?: number;
  topSeller?: string | null;
}

export interface BriefingInput {
  partOfDay?: "morning" | "afternoon" | "evening"; // caller derives from server time
  ownerName?: string | null;                        // e.g. "فهد"
  alerts?: BriefingAlert[];
  sales?: BriefingSales | null;
}

export interface Briefing {
  greetingAr: string;
  headlineAr: string;
  priorityAr: string | null;   // the single most important action (first high, else first alert)
  linesAr: string[];           // every alert, most urgent first
  salesLineAr: string | null;
  speak: string;               // clean spoken Arabic (no emoji/symbols), for TTS
  allClear: boolean;           // no high/med alerts
}

const RANK: Record<BriefingSeverity, number> = { high: 0, med: 1, low: 2 };

// Strip anything that makes TTS stumble: emoji/symbols, repeated dots, and
// collapse whitespace. (Matches Malak's speak-field rules.)
function speakSafe(s: string): string {
  return s
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{FE0F}]/gu, "")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

function fmtNum(n: number): string {
  // Integers plain; money to at most 2 decimals without trailing zeros.
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

export function composeBriefing(input: BriefingInput): Briefing {
  const part = input.partOfDay ?? "morning";
  const name = (input.ownerName ?? "").trim();
  const greetingAr = (part === "morning" ? "صباح الخير" : "مساء الخير") + (name ? ` يا ${name}` : "");

  const alerts = [...(input.alerts ?? [])].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const linesAr = alerts.map((a) => a.ar);
  const actionable = alerts.filter((a) => a.severity !== "low");
  const allClear = actionable.length === 0;

  const priorityAr =
    alerts.find((a) => a.severity === "high")?.ar ?? alerts[0]?.ar ?? null;

  const headlineAr = allClear
    ? "الوضع ممتاز، ما فيه شي عاجل اليوم."
    : `عندك ${actionable.length} ${actionable.length === 1 ? "بند" : "بنود"} تحتاج انتباهك.`;

  // Sales line (only when there were sales).
  let salesLineAr: string | null = null;
  const s = input.sales;
  if (s && s.units > 0) {
    let line = `مبيعات: ${fmtNum(s.units)} قطعة`;
    if (typeof s.revenue === "number" && s.revenue > 0) line += ` بقيمة ${fmtNum(s.revenue)}`;
    if (s.topSeller) line += `، الأكثر مبيعًا ${s.topSeller}`;
    salesLineAr = line;
  }

  // Spoken briefing — short, natural, Gulf. Two sentences max before sales.
  const parts: string[] = [greetingAr + "."];
  if (allClear) {
    parts.push("الوضع ممتاز اليوم، ما عندك شي عاجل.");
  } else {
    const n = actionable.length;
    parts.push(`عندك ${n} ${n === 1 ? "بند" : "بنود"} تحتاج انتباهك.`);
    if (priorityAr) parts.push(`الأهم: ${priorityAr}.`);
  }
  if (salesLineAr) parts.push(speakSafe(salesLineAr) + ".");
  const speak = speakSafe(parts.join(" "));

  return { greetingAr, headlineAr, priorityAr, linesAr, salesLineAr, speak, allClear };
}

/** morning < 12:00, afternoon < 17:00, else evening — from an hour (0-23). */
export function partOfDayFromHour(hour: number): "morning" | "afternoon" | "evening" {
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}
