// Legacy create URL — runtime-migrated to the V2 AI Product Creator (UX.4E-9A).
//
// The V2 flow (app/(v2)/v2/catalog/new → AiProductCreator → VariantStudio) is
// the ONLY active create path now. This page stays so every old bookmark, link
// and habit keeps working: it 308-redirects to the V2 wizard. The legacy editor
// (components/ProductForm.tsx) and the legacy createProduct action were deleted
// in UX.4E-9C; only this permanent redirect remains for backward compatibility.

import { permanentRedirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function NewProductPage() {
  permanentRedirect("/v2/catalog/new");
}
