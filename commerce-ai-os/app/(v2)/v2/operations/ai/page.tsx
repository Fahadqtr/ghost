// /v2/operations/ai — Unified AI Enrichment Center (OPS.5).
//
// Server Component. Read-only assembly: it reuses the CH.6E candidate scanner ONCE
// (via loadAiCenter), reads real applied-history + a SAFE provider-configured
// boolean, and renders the review workspace. Generation and apply are delegated to
// the existing CH.6E writer-gated server actions from the client — nothing is
// written on render. Read access follows the signed-in policy (the scanner
// enforces it); write affordances are gated on requireMalakWriter.

import { requireMalakWriter } from "@/lib/malak/authz";
import { createClient } from "@/lib/supabase/server";
import { CATEGORIES } from "@/lib/constants";
import { loadAiCenter } from "@/lib/operations/ai/ai-center.server";
import { parseAiFilters } from "@/lib/operations/ai/ai-center";
import AiCenter from "@/components/v2/operations/AiCenter";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذّر تحميل مركز الذكاء.";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

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

export default async function AiCenterPage({ searchParams }: { searchParams?: SearchParams }) {
  const writer = await requireMalakWriter();
  const canWrite = writer.ok;
  const params = searchParams ? await searchParams : {};
  const filters = parseAiFilters(params);

  const [view, brands] = await Promise.all([loadAiCenter(filters), loadBrandNames()]);

  if ("error" in view) {
    return (
      <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700" role="alert">
        {LOAD_ERROR}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-lg font-bold text-slate-800">مركز الذكاء — الإثراء</h1>
        <p className="text-sm text-muted">
          مكان واحد لكل عمليات الإثراء الذكي: نظرة عامة، قوائم عمل، ومساحة مراجعة موحّدة تنسّق محرّك CH.6E القائم. الفحص للقراءة،
          والتوليد يعطي اقتراحات فقط (لا يكتب)، والتطبيق يمرّ عبر حدود CH.6E المعتمدة ويحتاج صلاحية تعديل — لا يُطبَّق أي اقتراح
          تلقائيًا، ولا يُستبدل المحتوى الجيّد.
        </p>
      </header>
      <AiCenter model={view.model} filters={view.filters} canWrite={canWrite} brands={brands} categories={[...CATEGORIES]} />
    </div>
  );
}
