import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStaffMovements } from "../inventory/approvals-actions";
import ApprovalsClient from "../inventory/approvals/ApprovalsClient";
import PendingProductsList, { type PendingProduct } from "@/components/PendingProductsList";
import { getT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

// The owner's ONE approval center: staff-submitted products (approve/reject
// inline — approval fires the platforms task + Talabat queue), staff stock
// movements (the full review widget embedded), plus jump-off tiles for the
// other queues that live on their own pages (social drafts, Talabat email).

export default async function ApprovalCenterPage() {
  const { locale } = await getT();
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const supabase = createClient();

  // 1) Staff-submitted products awaiting approval.
  let pendingProducts: PendingProduct[] = [];
  try {
    const { data } = await supabase
      .from("products")
      .select("id, sku, name_en, name_ar, image_url, price, discount_price, main_category, notes, created_at")
      .is("approval", null)
      .like("notes", "staff-new:%")
      .order("created_at", { ascending: false })
      .limit(200);
    pendingProducts = ((data ?? []) as any[]).map((p) => ({
      id: String(p.id),
      sku: p.sku ?? null,
      name_en: p.name_en ?? null,
      name_ar: p.name_ar ?? null,
      image_url: p.image_url ?? null,
      price: p.price ?? null,
      discount_price: p.discount_price ?? null,
      main_category: p.main_category ?? null,
      submittedBy: String(p.notes ?? "").replace(/^staff-new:/, "").trim() || null,
      created_at: p.created_at ?? null,
    }));
  } catch { /* section shows empty */ }

  // 2) Staff stock movements (same widget as /inventory/approvals).
  let mvRows: Awaited<ReturnType<typeof getStaffMovements>>["rows"] = [];
  let mvPending = 0;
  let mvError: string | undefined;
  try {
    ({ rows: mvRows, pending: mvPending, error: mvError } = await getStaffMovements());
  } catch (e: any) {
    mvError = e?.message || L("تعذّر تحميل الحركات.", "Couldn't load movements.");
  }

  // 3) Counts for the queues that live on their own pages.
  let socialPending = 0;
  try {
    const { count } = await supabase.from("social_posts").select("id", { count: "exact", head: true }).eq("status", "pending");
    socialPending = count ?? 0;
  } catch { /* optional */ }

  let talabatPending = 0;
  try {
    const admin = createAdminClient();
    const { count, error } = await admin.from("talabat_queue").select("product_id", { count: "exact", head: true }).is("sent_at", null);
    if (!error) talabatPending = count ?? 0;
  } catch { /* table optional */ }

  const tiles: { label: string; n: number; href: string; icon: string }[] = [
    { icon: "🆕", label: L("منتجات الموظفين", "Staff products"), n: pendingProducts.length, href: "#products" },
    { icon: "📦", label: L("حركات المخزون", "Stock movements"), n: mvPending, href: "#movements" },
    { icon: "📣", label: L("منشورات السوشيال", "Social drafts"), n: socialPending, href: "/social" },
    { icon: "📬", label: L("إيميل طلبات", "Talabat email"), n: talabatPending, href: "/import-export/talabat-sync" },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-ink">✅ {L("مركز الاعتماد", "Approval center")}</h2>
        <p className="text-sm text-muted">{L("كل شي ينتظر قرارك في صفحة وحدة.", "Everything awaiting your decision, in one place.")}</p>
      </div>

      {/* summary tiles */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map((t) => (
          <Link key={t.label} href={t.href}
            className={`rounded-xl border p-3 text-center transition hover:bg-violet-50 ${t.n > 0 ? "border-amber-200 bg-amber-50/60" : "border-[#efe3d6] bg-white"}`}>
            <div className={`text-2xl font-extrabold ${t.n > 0 ? "text-amber-700" : "text-ink"}`}>{t.n}</div>
            <div className="mt-0.5 text-xs text-muted">{t.icon} {t.label}</div>
          </Link>
        ))}
      </div>

      {/* 1) staff products */}
      <div id="products" className="card space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">🆕 {L("منتجات الموظفين بانتظار اعتمادك", "Staff products awaiting approval")} ({pendingProducts.length})</h3>
          <p className="text-xs text-muted">
            {L("الاعتماد يفتح مهمة «أضفه للمنصات» تلقائيًا ويدخل المنتج طابور إيميل طلبات. ✏️ يفتح المنتج للتعديل قبل القرار.",
               "Approving auto-opens the platforms task and queues the product for the Talabat email. ✏️ opens the product for edits first.")}
          </p>
        </div>
        <PendingProductsList items={pendingProducts} locale={locale} />
      </div>

      {/* 2) stock movements */}
      <div id="movements" className="card space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-ink">📦 {L("حركات المخزون من الموظفين", "Staff stock movements")}</h3>
            <p className="text-xs text-muted">{L("راجِع كل دخول/خروج سجّله الموظفون — اعتمد أو اعكس.", "Review every staff stock in/out — approve or reverse.")}</p>
          </div>
          <Link href="/inventory/approvals" className="btn-ghost shrink-0 px-3 py-1 text-xs whitespace-nowrap">{L("الصفحة الكاملة ←", "Full page →")}</Link>
        </div>
        {mvError ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{mvError}</div>
        ) : (
          <ApprovalsClient initialRows={mvRows} initialPending={mvPending} locale={locale} />
        )}
      </div>
    </div>
  );
}
