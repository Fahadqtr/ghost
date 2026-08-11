// Brand-name → brand_id resolution (extracted from AiProductCreator so the AI
// create flow and the UX.4D AI-fill adapter share ONE matcher — no duplication).
// PURE: an exact, case-insensitive name match only. It NEVER invents a brand_id —
// an unknown name returns "" so a raw AI brand string can never fabricate an id.

export interface BrandOption {
  id: string;
  name: string;
}

export function matchBrandId(brands: readonly BrandOption[], brandName: string): string {
  const want = String(brandName ?? "").trim().toLowerCase();
  if (!want) return "";
  const hit = brands.find((b) => String(b.name ?? "").trim().toLowerCase() === want);
  return hit ? hit.id : "";
}
