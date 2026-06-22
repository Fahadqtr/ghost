/** Derive the shelf letter from a slot code: "A1" -> "A", "AB12" -> "AB". */
export function shelfOf(code: string | null | undefined): string | null {
  if (!code) return null;
  const m = code.trim().match(/^[A-Za-z]+/);
  const letters = m ? m[0] : code.trim().charAt(0);
  return letters ? letters.toUpperCase() : null;
}

/** Sort slot codes naturally: A1, A2, A10, B1 … */
export function compareSlot(a: string, b: string): number {
  const sa = shelfOf(a) ?? "";
  const sb = shelfOf(b) ?? "";
  if (sa !== sb) return sa < sb ? -1 : 1;
  const na = parseInt(a.replace(/^[A-Za-z]+/, ""), 10) || 0;
  const nb = parseInt(b.replace(/^[A-Za-z]+/, ""), 10) || 0;
  return na - nb;
}
