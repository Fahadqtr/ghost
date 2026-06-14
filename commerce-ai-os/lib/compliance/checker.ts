// Deterministic 7-check engine (malika-compliance-checker-spec.md §2).
//
// This is the ENFORCEMENT layer — compliance is decided in code, not by an LLM
// prompt, so it is reproducible, testable offline, and cannot be "talked out"
// of a BLOCK. The Claude agent (agent.ts) shares the same rulebook for the
// fuzzy checks, but the gate runs on this.
//
// Severity → overall (spec §1): any BLOCK ⇒ BLOCK (publish_allowed=false);
// else any WARN ⇒ WARN (publish); else PASS. needs_human ⇒ overall===BLOCK.

import type {
  CheckResult,
  Draft,
  RulesConfig,
  Severity,
  Verdict,
} from "./types";

const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "");

function countKeywords(s?: string | null): number {
  if (isEmpty(s)) return 0;
  return (s as string)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean).length;
}

/** Whole-word match. Latin uses non-alphanumeric boundaries; Arabic uses a
 *  word boundary that (a) forbids trailing Arabic letters — so طبي never matches
 *  inside طبيعي ("natural") — and (b) allows a leading Arabic proclitic / ال
 *  prefix — so a prefixed form like العلاج still matches علاج. Returns the first
 *  matched term or null. */
const AR = "\\u0600-\\u06FF"; // Arabic block (letters + diacritics + tatweel)

type JargonEx = { terms: string[]; context: string[]; window: number };
/** True when EVERY occurrence of `term` (a single Latin word) sits within
 *  `window` words of a context word — i.e. it's domain jargon, not a claim. */
function jargonExempt(lower: string, term: string, ex: JargonEx): boolean {
  if (!ex || !ex.terms.map((s) => s.toLowerCase()).includes(term)) return false;
  const words = lower.split(/[^a-z0-9]+/).filter(Boolean);
  const ctx = new Set(ex.context.map((c) => c.toLowerCase()));
  const occ: number[] = [];
  for (let i = 0; i < words.length; i++) if (words[i] === term) occ.push(i);
  if (occ.length === 0) return false;
  for (const i of occ) {
    let near = false;
    for (let j = Math.max(0, i - ex.window); j <= Math.min(words.length - 1, i + ex.window); j++) {
      if (ctx.has(words[j])) { near = true; break; }
    }
    if (!near) return false; // a real, non-jargon occurrence
  }
  return true;
}

function firstForbidden(
  text: string | null | undefined,
  terms: string[],
  ex?: JargonEx
): string | null {
  if (isEmpty(text)) return null;
  const raw = text as string;
  const lower = raw.toLowerCase();
  for (const term of terms) {
    const t = term.trim();
    if (!t) continue;
    const latin = /^[\x00-\x7F]+$/.test(t);
    if (latin) {
      const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(t.toLowerCase())}(?:$|[^a-z0-9])`, "i");
      if (re.test(lower)) {
        if (ex && jargonExempt(lower, t.toLowerCase(), ex)) continue;
        return term;
      }
    } else {
      const re = new RegExp(`(?:^|[^${AR}]|ال|[وفبكل])${escapeRe(t)}(?![${AR}])`, "u");
      if (re.test(raw)) return term;
    }
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function check(name: CheckResult["name"], severity: Severity, detail: string, evidence: string | null = null): CheckResult {
  return { name, severity, detail, evidence };
}

// 1. Medical claims (BLOCK) ---------------------------------------------------
function checkMedical(d: Draft, r: RulesConfig): CheckResult {
  const allowed = new Set(r.on_label_claims.map((s) => s.toLowerCase()));
  const en = firstForbidden(d.desc_en, r.forbidden_terms_en, r.medical_jargon_exceptions);
  if (en && !allowed.has(en.toLowerCase()))
    return check("medical_claims", "BLOCK", "Forbidden medical/claim term in desc_en", en);
  const ar = firstForbidden(d.desc_ar, r.forbidden_terms_ar, r.medical_jargon_exceptions);
  if (ar && !allowed.has(ar.toLowerCase()))
    return check("medical_claims", "BLOCK", "Forbidden medical/claim term in desc_ar", ar);
  return check("medical_claims", "PASS", "No forbidden medical claims");
}

// 2. Image (BLOCK; white-bg → WARN if enabled) --------------------------------
function checkImage(d: Draft, r: RulesConfig): CheckResult {
  if (isEmpty(d.image_url)) return check("image", "BLOCK", "Missing image_url");
  if (!/^https:\/\//i.test(d.image_url as string))
    return check("image", "BLOCK", "image_url must be HTTPS", d.image_url ?? null);
  if (r.image_rules.require_white_bg_check)
    return check("image", "WARN", "White background not verified — queue for manual check", d.image_url ?? null);
  return check("image", "PASS", "Valid HTTPS image");
}

// 3. Format (BLOCK) -----------------------------------------------------------
function checkFormat(d: Draft, r: RulesConfig): CheckResult {
  const f = r.format_rules;
  if (f.require_en && isEmpty(d.title_en)) return check("format", "BLOCK", "Missing title_en", null);
  if (f.require_ar && isEmpty(d.title_ar)) return check("format", "BLOCK", "Missing title_ar", null);
  let re: RegExp;
  try {
    re = new RegExp(f.sku_pattern);
  } catch {
    return check("format", "BLOCK", "Invalid sku_pattern in rules", f.sku_pattern);
  }
  if (isEmpty(d.sku) || !re.test(d.sku))
    return check("format", "BLOCK", `SKU does not match ${f.sku_pattern}`, d.sku ?? null);
  return check("format", "PASS", "Title + SKU format valid");
}

// 4. Price consistency (BLOCK) ------------------------------------------------
function checkPrice(d: Draft): CheckResult {
  if (d.discount_price !== null && d.discount_price !== undefined)
    return check("price_consistency", "PASS", "Discount price set — mismatch allowed");
  const platform = d.platform_prices ?? {};
  const entries = Object.entries(platform);
  const baseline = d.price ?? (entries.length ? entries[0][1] : undefined);
  const mismatches = entries.filter(([, v]) => v !== baseline);
  if (mismatches.length)
    return check(
      "price_consistency",
      "BLOCK",
      "Platform prices differ with no discount set",
      mismatches.map(([k, v]) => `${k}=${v}`).join(", ") + ` (base ${baseline})`
    );
  return check("price_consistency", "PASS", "Prices consistent across platforms");
}

// 5. Category (WARN) ----------------------------------------------------------
function checkCategory(d: Draft, r: RulesConfig): CheckResult {
  if (!isEmpty(d.main_category) && r.valid_categories.includes(d.main_category as string))
    return check("category", "PASS", "Category is one of the locked categories");
  return check(
    "category",
    "WARN",
    `Not a locked category — recommend routing to "${r.category_fallback}"`,
    d.main_category ?? null
  );
}

// 6. Required fields (WARN) ---------------------------------------------------
function checkRequired(d: Draft, r: RulesConfig): CheckResult {
  const missing: string[] = [];
  // `size` is intentionally NOT required — sizes live in the product titles
  // (e.g. "...- 50g"); the size column is backfilled as a separate task.
  for (const k of ["name_en", "name_ar", "desc_en", "desc_ar", "image_url"] as const) {
    if (isEmpty(d[k])) missing.push(k);
  }
  if (d.price === null || d.price === undefined) missing.push("price");
  const { keywords_min, keywords_max } = r.format_rules;
  const en = countKeywords(d.keywords_en);
  const ar = countKeywords(d.keywords_ar);
  if (en < keywords_min || en > keywords_max) missing.push(`keywords_en(${en})`);
  if (ar < keywords_min || ar > keywords_max) missing.push(`keywords_ar(${ar})`);
  if (missing.length)
    return check("required_fields", "WARN", "Missing/invalid required fields", missing.join(", "));
  return check("required_fields", "PASS", "All required fields present");
}

// 7. Fabricated data (WARN) ---------------------------------------------------
function checkFabricated(d: Draft, r: RulesConfig): CheckResult {
  const text = `${d.desc_en ?? ""}\n${d.desc_ar ?? ""}`;
  for (const pat of r.fabrication_patterns) {
    let re: RegExp;
    try {
      re = new RegExp(pat, "i");
    } catch {
      continue;
    }
    const m = re.exec(text);
    if (m) return check("fabricated_data", "WARN", "Possible invented delivery/stock claim", m[0]);
  }
  return check("fabricated_data", "PASS", "No fabricated data detected");
}

const RANK: Record<Severity, number> = { PASS: 0, WARN: 1, BLOCK: 2 };

/** Run all 7 checks and compute the overall verdict (spec §1 + §2). */
export function runChecks(draft: Draft, rules: RulesConfig): Verdict {
  const checks: CheckResult[] = [
    checkMedical(draft, rules),
    checkImage(draft, rules),
    checkFormat(draft, rules),
    checkPrice(draft),
    checkCategory(draft, rules),
    checkRequired(draft, rules),
    checkFabricated(draft, rules),
  ];
  const overall = checks.reduce<Severity>(
    (acc, c) => (RANK[c.severity] > RANK[acc] ? c.severity : acc),
    "PASS"
  );
  return {
    sku: draft.sku,
    overall,
    publish_allowed: overall !== "BLOCK",
    needs_human: overall === "BLOCK",
    checks,
  };
}

/** Default rules — used only as a safety fallback if compliance_rules can't be
 *  read. Production reads the live, editable rows. Mirrors the seed. */
export const DEFAULT_RULES: RulesConfig = {
  valid_categories: [
    "Face Care", "Body Care", "Hair Care", "Makeup", "Lashes & Nails",
    "Beauty Accessories", "Beauty Bundle", "Masks", "Sun Protection",
    "Dental Care", "Women’s Essentials", "Rhode Products Section",
    "Thailand Products", "Summer And Camping Supplies", "Electronics",
    "✨Toys", "Uncategorized",
  ],
  forbidden_terms_en: [
    "cure", "cures", "heal", "heals", "treat", "treats", "treatment", "medical",
    "clinically guaranteed", "eliminates acne", "removes wrinkles permanently",
    "fda", "prescription", "diagnose", "allergy-free",
  ],
  forbidden_terms_ar: [
    "يعالج", "علاج", "يشفي", "يشفى", "يداوي", "طبي",
    "يقضي على حب الشباب نهائياً", "يزيل التجاعيد نهائياً", "مضمون طبياً",
    "آمن لجميع أنواع الحساسية", "يعالج الإكزيما", "تشخيص",
  ],
  format_rules: {
    // Option C — accepts the store's real mk#### SKUs and hyphenated
    // BRAND-PRODUCT-VARIANT. Mirrors the compliance_rules seed.
    sku_pattern: "^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$",
    require_ar: true,
    require_en: true,
    keywords_min: 5,
    keywords_max: 10,
  },
  fabrication_patterns: [
    "\\bships? in \\d", "\\bdelivery in \\d",
    "\\bwithin \\d+ ?(hours|hrs|days|day)\\b", "\\b\\d+ ?(hours|hrs) delivery\\b",
    "\\bin stock\\b *: *\\d", "\\b\\d+ in stock\\b", "\\bsame[- ]day delivery\\b",
  ],
  category_fallback: "Uncategorized",
  on_label_claims: [],
  image_rules: { require_white_bg_check: false },
  medical_jargon_exceptions: {
    terms: ["cure", "cures"],
    context: ["gel", "uv", "led", "nail", "nails", "polish", "lamp", "manicure"],
    window: 4,
  },
};
