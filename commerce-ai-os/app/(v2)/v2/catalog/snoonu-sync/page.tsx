// /v2/catalog/snoonu-sync — Snoonu catalog sync (owner redesign): the Snoonu
// update workbook is the CURRENT Snoonu catalog state; SPI is the primary
// identity; preview is read-only; apply is an explicit OWNER confirmation.
// Server Component shell — nothing is read or written here.

import SnoonuSync from "@/components/v2/catalog/SnoonuSync";
import { isOwner } from "@/lib/malak/authz";

export const dynamic = "force-dynamic";

export default async function SnoonuSyncPage() {
  return <SnoonuSync isOwner={await isOwner()} />;
}
