// /v2 — the V2 entry point. Phase UI.1 has only the catalog, so redirect there
// (no placeholder dashboard).

import { redirect } from "next/navigation";

export default function V2IndexPage() {
  redirect("/v2/catalog");
}
