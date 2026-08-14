// Legacy edit URL — runtime-migrated to the V2 Product Editor (UX.4E-9A).
//
// The V2 flow (app/(v2)/v2/catalog/[id]/edit → ProductEditForm → VariantStudio)
// is the ONLY active edit path now. This page stays so old bookmarks and links
// keep working: it 308-redirects to the V2 editor for the same product id. The
// legacy editor (components/ProductForm.tsx) and the legacy updateProduct action
// were deleted in UX.4E-9C; only this permanent redirect remains.
//
// Legacy-only conveniences that lived on THIS page and are documented (not
// silently dropped) by the migration:
//  • in-form delete → still available at runtime via /catalog/health;
//  • AI photo edit → still available via the /staff tab (same engine);
//  • scanner Enter-flow (Enter jumps to the next barcode field) → ported into the
//    shared V2 VariantStudio in UX.4E-9C, so Create and Edit both have it now.

import { permanentRedirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  permanentRedirect(`/v2/catalog/${encodeURIComponent(id)}/edit`);
}
