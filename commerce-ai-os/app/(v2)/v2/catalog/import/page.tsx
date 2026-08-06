// /v2/catalog/import — Malikas V2 catalog Excel import (Phase UI.6). Server
// Component shell: auth comes from the (v2) layout gate, every server action
// re-checks the session itself, and NOTHING is read or written here — the
// whole flow (upload → sheet → mapping → preview → separate apply steps)
// lives in the client wizard + its stateless server actions.

import CatalogExcelImport from "@/components/v2/catalog/CatalogExcelImport";

export const dynamic = "force-dynamic";

export default function CatalogImportPage() {
  return <CatalogExcelImport />;
}
