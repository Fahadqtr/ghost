"use server";

// V2 product-editor save action (Phase UI.4). A thin shell: auth gate, pure
// validation, then the SHARED save core (lib/products/product-save.ts) — the
// same path the legacy editor uses, so there is exactly one write flow and it
// preserves every retained variant's uuid. Session client only (RLS applies);
// no admin client, no new RPC, no SQL here.
//
// Every failure returns one of the fixed Arabic messages from
// lib/products/edit-validation.ts. The legacy English / database-derived
// strings from the core are never surfaced, so no SQLSTATE, constraint name,
// uuid or raw Supabase text can reach the page.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSignedIn } from "@/lib/auth/requireUser";
import { updateProductCore, type ProductInput } from "@/lib/products/product-save";
import { createInventoryAdapter, applyEditorInventoryEffects } from "@/lib/products/inventory-editor-adapter";
import { EDIT_MESSAGES, editFailureMessage, validateProductEditInput } from "@/lib/products/edit-validation";
import {
  catalogDetailHref,
  parseCatalogControls,
  parseProductId,
} from "@/lib/catalog-v2/master-catalog-view";

export async function saveProductEdit(
  productId: string,
  input: ProductInput,
  rawControls: Record<string, string | string[] | undefined>,
): Promise<{ error: string }> {
  if (!(await isSignedIn())) return { error: EDIT_MESSAGES.not_signed_in };

  const validId = parseProductId(productId);
  if (validId === null) return { error: EDIT_MESSAGES.invalid_input };

  const validation = validateProductEditInput(input);
  if (!validation.ok) return { error: validation.message };

  // Product metadata + the SECURITY INVOKER variant RPC run on the SESSION client
  // (RLS applies). Numeric inventory quantities go ONLY through the service-role
  // Inventory Engine, injected as a narrow adapter built AFTER the auth gate — the
  // admin client is never used for the product metadata write and never leaves here.
  const supabase = createClient();
  const admin = createAdminClient();
  const core = await updateProductCore(supabase, validId, input, {
    inventory: createInventoryAdapter(admin),
    // INV.6B — the atomic variant-sync RPC is admin-only (service-role) after the
    // lockdown, so it runs on the admin client; product metadata stays on `supabase`.
    variantSyncClient: admin,
  });
  if (!core.ok) return { error: editFailureMessage(core) };

  // Best-effort authoritative transition + audit (never undoes the save).
  await applyEditorInventoryEffects(admin, {
    productId: validId,
    sku: (core.row.sku as string | null) ?? null,
    core,
  });

  // Rebuild the return target from VALIDATED controls only — the raw object
  // from the client is parsed through the same whitelist as the catalog pages,
  // so the redirect can only ever point at /v2/catalog/<id> with known params.
  const controls = parseCatalogControls(rawControls);
  const detailHref = catalogDetailHref(validId, controls);

  revalidatePath("/v2/catalog");
  revalidatePath(`/v2/catalog/${validId}`);
  redirect(`${detailHref}${detailHref.includes("?") ? "&" : "?"}saved=1`);
}
