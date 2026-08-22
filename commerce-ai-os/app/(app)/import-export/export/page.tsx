// /import-export/export — RETIRED (INT.2F.2; redirect canonicalised by UX.NAV.2).
//
// This page existed only to host the legacy Talabat CSV export trigger, whose GET
// side-effect was the sole writer of channel_variant_mappings. INT.2F.2 retired
// the CSV route and re-homed mapping persistence to the certified Talabat package
// flow (syncTalabatMappingsFromCatalog, invoked from the writer-gated
// /api/export/talabat/package route). The Export Center is the ONLY
// operator-facing export path for every channel, so this page permanently
// redirects to the Export Center DASHBOARD — the hub card promises
// Rafeeq/Shopify/Snoonu/Talabat, so the channel picker (not one channel's
// detail page) is the canonical landing. (Talabat Orders and other Talabat
// workflows are unaffected — they live on their own routes.)

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function ImportExportExportsPage() {
  redirect("/v2/export");
}
