// /v2/operations/ai-enrichment — Bulk AI Product Enrichment (CH.6E).
//
// Server Component. Computes the writer affordance (canWrite) and loads the brand
// + category option lists for the filters (read-only). Generation and apply are
// writer-gated inside the server actions + orchestrator; nothing is written on
// render — the page performs no scan/generate/apply itself.

import { requireMalakWriter } from "@/lib/malak/authz";
import { createClient } from "@/lib/supabase/server";
import { CATEGORIES } from "@/lib/constants";
import AiEnrichment from "@/components/v2/operations/AiEnrichment";

export const dynamic = "force-dynamic";

async function loadBrandNames(): Promise<string[]> {
  try {
    const sb = createClient();
    const { data } = await sb.from("brands").select("name").order("name");
    return (Array.isArray(data) ? data : [])
      .map((r) => (r as { name?: unknown }).name)
      .filter((n): n is string => typeof n === "string" && n.trim() !== "");
  } catch {
    return [];
  }
}

export default async function AiEnrichmentPage() {
  const writer = await requireMalakWriter();
  const brands = await loadBrandNames();

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-lg font-bold text-slate-800">الإثراء الذكي للمنتجات</h1>
        <p className="text-sm text-muted">
          توليد كلمات مفتاحية وأوصاف مفقودة/ضعيفة بالجملة من حقائق الكتالوج فقط — دون فتح المنتجات واحدًا واحدًا.
          الاقتراحات لا تُطبَّق تلقائيًا: افحص، ولّد، راجِع، ثم طبِّق المعتمد فقط. لا يمسّ المخزون أو التوفّر أو الباركود أو الصور أو القنوات.
        </p>
      </header>
      <AiEnrichment canWrite={writer.ok} brands={brands} categories={[...CATEGORIES]} />
    </div>
  );
}
