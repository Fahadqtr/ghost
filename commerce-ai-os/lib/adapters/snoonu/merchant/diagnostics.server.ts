import "server-only";
import { requireOwner } from "@/lib/malak/authz";
import { createClient } from "@/lib/supabase/server";
import { SNOONU_STOREFRONT_KEYS } from "./merchant-contract";
import type { SnoonuStorefrontKey } from "./merchant-contract";
import { diagnoseSnoonuSearchModes } from "./live-adapter.server";
import type { SnoonuSearchDiagnostic } from "./live-adapter.server";

// MEDIA.1C-HOTFIX3 — OWNER-ONLY identity-search diagnostic (READ-ONLY).
//
// Runs the three verified portal searches for ONE product and reports, per
// mode, the transport outcome + raw row count + exact-equality survivors + the
// portal's own identifier values on the first row — the runtime evidence needed
// to tell apart: identity mode rejected (401/403), portal finds nothing for the
// term, portal rows exist but identifiers differ (equality/normalization), or
// parsing yields nothing. It writes nothing and never returns secret material.

export interface IdentityDiagnosticReport {
  product: { id: string; sku: string | null; barcode: string | null; name: string | null };
  diagnostic: SnoonuSearchDiagnostic;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

export async function runSnoonuIdentityDiagnostic(
  productId: string,
  storefrontKey: SnoonuStorefrontKey,
): Promise<IdentityDiagnosticReport | { error: string }> {
  const owner = await requireOwner();
  if (!owner.ok) return { error: owner.error };
  const key = SNOONU_STOREFRONT_KEYS.find((k) => k === storefrontKey);
  if (!key) return { error: "متجر غير معروف." };
  const pid = str(productId);
  if (!pid) return { error: "منتج غير محدد." };

  const sb = createClient();
  const { data, error } = await sb
    .from("products")
    .select("id, sku, barcode, name_en, name_ar")
    .eq("id", pid)
    .limit(1);
  if (error) return { error: "تعذّر قراءة المنتج." };
  const r = (data ?? [])[0] as Record<string, unknown> | undefined;
  if (!r) return { error: "المنتج غير موجود." };

  const product = {
    id: String(r.id),
    sku: str(r.sku),
    barcode: str(r.barcode),
    name: str(r.name_en) ?? str(r.name_ar),
  };
  const diagnostic = await diagnoseSnoonuSearchModes(key, {
    barcode: product.barcode,
    sku: product.sku,
    name: product.name,
  });
  return { product, diagnostic };
}
