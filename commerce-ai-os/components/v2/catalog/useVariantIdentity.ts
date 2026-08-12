"use client";

// Shared variant-identity orchestration (UX.4E-2).
//
// Owns ONLY orchestration: the once-fetched catalog identity snapshot, the busy
// flag, and the seven generate/copy actions wired to the main SKU/barcode
// "توليد" buttons and the VariantIdentityToolbar. Every business rule lives in
// the pure helpers it calls — identity-fill (via variant-model's row
// transforms), sku-generate, barcode-ean13 — so this file contains NO
// duplicated generator logic.
//
// Create and Edit inject the ONE place they legitimately differ: how a generated
// MAIN SKU is written. The create wizard renumbers the variant SKUs to the new
// prefix (its `onMainSkuChange`); the edit form writes the scalar only. That
// difference lives at the `setMainSku` boundary, never forked inside here.

import { useState } from "react";
import {
  loadCatalogIdentity,
  type CatalogIdentity,
} from "@/app/(v2)/v2/catalog/identity-actions";
import { nextMainBarcode, nextMainSku } from "@/lib/products/identity-fill";
import {
  applyAllMissingVariantIdentity,
  applyMissingVariantBarcodes,
  applyMissingVariantSkus,
  applyProductPriceToEmptyVariants,
  renumberVariantRowSkus,
  type VariantRowModel,
} from "@/lib/products/variant-model";

const IDENTITY_LOAD_ERROR = "تعذّر فحص الكتالوج للتوليد. حاول مرة أخرى.";
const CONFIRM_REPLACE_SKU = "سيتم استبدال SKU الحالي. متابعة؟";
const CONFIRM_REPLACE_BARCODE = "سيتم استبدال الباركود الحالي. متابعة؟";
const CONFIRM_RENUMBER = "سيتم إعادة ترقيم كل SKU للخيارات وفق SKU المنتج. متابعة؟";

export interface UseVariantIdentityArgs {
  /** Current main SKU (scalars.sku). */
  mainSku: string;
  /** Current product barcode (scalars.barcode). */
  mainBarcode: string;
  /** Current product price (scalars.price). */
  productPrice: string;
  /** Current variant rows. */
  rows: readonly VariantRowModel[];
  /**
   * Write a generated main SKU. Create injects `onMainSkuChange` (which also
   * renumbers the variant SKUs to the new prefix); Edit injects a plain scalar
   * setter. This is the only intentional create/edit divergence.
   */
  setMainSku: (value: string) => void;
  /** Write a generated product barcode. */
  setMainBarcode: (value: string) => void;
  /** Functional row updater (same shape as React's setState updater). */
  setRows: (updater: (rows: VariantRowModel[]) => VariantRowModel[]) => void;
  /** Surface a fixed Arabic error message. */
  onError: (message: string) => void;
  /** Injectable for tests; defaults to window.confirm. */
  confirm?: (message: string) => boolean;
  /** Injectable for tests; defaults to Math.random. */
  random?: () => number;
}

export interface VariantIdentityController {
  identityBusy: boolean;
  generateMainSku: () => Promise<void>;
  generateMainBarcode: () => Promise<void>;
  generateMissingVariantSku: () => void;
  generateMissingVariantBarcode: () => Promise<void>;
  generateAllMissing: () => Promise<void>;
  copyVariantSkuPrefix: () => void;
  copyVariantPrice: () => void;
}

export function useVariantIdentity(
  args: UseVariantIdentityArgs,
): VariantIdentityController {
  const [identity, setIdentity] = useState<CatalogIdentity | null>(null);
  const [identityBusy, setIdentityBusy] = useState(false);
  const confirmFn = args.confirm ?? ((message: string) => window.confirm(message));
  const random = args.random ?? Math.random;

  // Fetch the catalog identity snapshot once (read-only) for collision-safe
  // generation. Cached in state; a failure surfaces a fixed Arabic message.
  async function ensureIdentity(): Promise<CatalogIdentity | null> {
    if (identity) return identity;
    setIdentityBusy(true);
    try {
      const res = await loadCatalogIdentity();
      if ("error" in res) {
        args.onError(IDENTITY_LOAD_ERROR);
        return null;
      }
      setIdentity(res.data);
      return res.data;
    } finally {
      setIdentityBusy(false);
    }
  }

  async function generateMainSku(): Promise<void> {
    const id = await ensureIdentity();
    if (!id) return;
    if (args.mainSku.trim() !== "" && !confirmFn(CONFIRM_REPLACE_SKU)) return;
    args.setMainSku(nextMainSku(id.skus));
  }

  async function generateMainBarcode(): Promise<void> {
    const id = await ensureIdentity();
    if (!id) return;
    if (args.mainBarcode.trim() !== "" && !confirmFn(CONFIRM_REPLACE_BARCODE)) return;
    args.setMainBarcode(nextMainBarcode(new Set(id.barcodes), random));
  }

  function generateMissingVariantSku(): void {
    args.setRows((rows) => applyMissingVariantSkus(args.mainSku, rows));
  }

  async function generateMissingVariantBarcode(): Promise<void> {
    const id = await ensureIdentity();
    if (!id) return;
    args.setRows((rows) =>
      applyMissingVariantBarcodes(rows, new Set(id.barcodes), random, [args.mainBarcode]),
    );
  }

  async function generateAllMissing(): Promise<void> {
    const id = await ensureIdentity();
    if (!id) return;
    args.setRows((rows) =>
      applyAllMissingVariantIdentity(
        args.mainSku,
        rows,
        new Set(id.barcodes),
        random,
        [args.mainBarcode],
      ),
    );
  }

  function copyVariantSkuPrefix(): void {
    const anyNonEmpty = args.rows.some((r) => !r.removed && r.fields.sku.trim() !== "");
    if (anyNonEmpty && !confirmFn(CONFIRM_RENUMBER)) return;
    args.setRows((rows) => renumberVariantRowSkus(args.mainSku, rows));
  }

  function copyVariantPrice(): void {
    args.setRows((rows) => applyProductPriceToEmptyVariants(args.productPrice, rows));
  }

  return {
    identityBusy,
    generateMainSku,
    generateMainBarcode,
    generateMissingVariantSku,
    generateMissingVariantBarcode,
    generateAllMissing,
    copyVariantSkuPrefix,
    copyVariantPrice,
  };
}
