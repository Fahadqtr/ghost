"use server";

// Malikas V2 — catalog identity snapshot (UX.4B). A READ-ONLY server action shared
// by the create + edit forms so their client-side SKU/barcode "generate" buttons
// can avoid collisions against the whole catalog. It reuses the EXISTING
// server-only loadIdentitySnapshot (products + product_variants) — no new reader,
// no write, no RPC, no save. Re-checks the session like every mutating action, but
// this one only reads.

import { createClient } from "@/lib/supabase/server";
import { isSignedIn } from "@/lib/auth/requireUser";
import { loadIdentitySnapshot } from "@/lib/products/catalog-identity-read";

export interface CatalogIdentity {
  /** every existing product + variant SKU (for nextMkSku). */
  skus: string[];
  /** every existing product + variant barcode (for EAN-13 collision checks). */
  barcodes: string[];
  /** true when the read hit its safety cap (surfaced, never silent). */
  partial: boolean;
}

export async function loadCatalogIdentity(): Promise<{ data: CatalogIdentity } | { error: true }> {
  if (!(await isSignedIn())) return { error: true };
  const supabase = createClient();
  const result = await loadIdentitySnapshot(supabase);
  if (result.status !== "ok") return { error: true };
  return {
    data: {
      skus: result.snapshot.skus,
      barcodes: [...result.snapshot.barcodes],
      partial: result.snapshot.partial,
    },
  };
}
