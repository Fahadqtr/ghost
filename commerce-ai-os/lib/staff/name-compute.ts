// Pure staff-name canonicalization + match — the "username" check at staff login.
// DB/crypto-free so it can be unit-tested. Lenient on case, spacing, Arabic
// diacritics/tatweel and common alef/ya/ta-marbuta spelling variants, so an
// employee typing their own name isn't blocked by a trivial difference.

export function canonName(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[ً-ْٰـ]/g, "") // Arabic short vowels + superscript alef + tatweel
    .replace(/[إأآٱ]/g, "ا")                      // alef forms → bare alef
    .replace(/ى/g, "ي")                           // alef maqsura → ya
    .replace(/ة/g, "ه")                           // ta marbuta → ha
    .replace(/\s+/g, " ")
    .trim();
}

/** Does the typed login name match the employee's stored name? Empty never matches. */
export function staffNameMatches(typed: unknown, record: unknown): boolean {
  const a = canonName(typed);
  const b = canonName(record);
  return !!a && a === b;
}
