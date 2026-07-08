"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { revalidatePath } from "next/cache";
import { isSignedIn } from "@/lib/auth/requireUser";
import { verdictForTask, type VerifyTaskLite } from "@/lib/tasks/verify-compute";
import { insertComment } from "@/lib/tasks/commentStore";
import { detectTalabatColumns, baseSku } from "@/lib/talabat-diff";
import { diffTalabat, talabatEmailText, imageFileFor, type TalabatDiff, type TalabatOurRow } from "@/lib/talabat-diff";
import { buildTalabatRows, TALABAT_HEADERS } from "@/lib/malak/talabat-export.mjs";

export type { TalabatDiff } from "@/lib/talabat-diff";

// Talabat has no API — the owner uploads Talabat's own catalog export, we
// diff it against the catalog, then build the "please add these" package:
// a sheet in the exact 10-column Talabat format + the matching images ZIP +
// a ready email. Products WITH options are split into one standalone row per
// option (Talabat rejects variant products, so each option ships solo).

const EMPTY_DIFF: TalabatDiff = {
  ok: false, columns: {},
  counts: { ours: 0, eligible: 0, withOptions: 0, notApproved: 0, theirRows: 0, matched: 0, missing: 0, noPrice: 0, extraOnTalabat: 0 },
  missing: [], extraOnTalabat: [],
};

async function pageAll<T>(q: (from: number, to: number) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

/* ── Talabat new-product queue ────────────────────────────────────────────
   Products land here automatically when they become Approved; the owner
   downloads the sheet+images from this page, emails Talabat, then marks the
   batch sent — after which the items disappear from the queue. */

export interface TalabatQueueItem {
  id: string;
  sku: string | null;
  name_en: string | null;
  image_url: string | null;
  queued_at: string | null;
  noPrice: boolean;
}

export async function listTalabatQueue(): Promise<{ ok: boolean; ready: boolean; items: TalabatQueueItem[]; error?: string }> {
  if (!(await isSignedIn())) return { ok: false, ready: true, items: [], error: "Not signed in." };
  try {
    const admin = createAdminClient();
    const { data: q, error } = await admin
      .from("talabat_queue")
      .select("product_id, queued_at")
      .is("sent_at", null)
      .order("queued_at", { ascending: false })
      .limit(500);
    if (error) {
      if ((error as any).code === "42P01" || /talabat_queue/i.test(error.message)) {
        return { ok: true, ready: false, items: [] }; // migration not run yet
      }
      return { ok: false, ready: true, items: [], error: error.message };
    }
    const ids = ((q ?? []) as { product_id: string; queued_at: string | null }[]);
    if (!ids.length) return { ok: true, ready: true, items: [] };

    const queuedAt = new Map(ids.map((r) => [String(r.product_id), r.queued_at ?? null]));
    const { data: prods } = await admin
      .from("products")
      .select("id, sku, name_en, name_ar, image_url, price, discount_price, approval")
      .in("id", ids.map((r) => r.product_id));

    const items: TalabatQueueItem[] = ((prods ?? []) as any[])
      .filter((p) => String(p.approval ?? "") === "Approved") // rejected later? drop from view
      .map((p) => ({
        id: String(p.id),
        sku: p.sku ?? null,
        name_en: p.name_en ?? p.name_ar ?? null,
        image_url: p.image_url ?? null,
        queued_at: queuedAt.get(String(p.id)) ?? null,
        noPrice: !(Number(p.price) > 0 || Number(p.discount_price) > 0),
      }))
      .sort((a, b) => String(b.queued_at ?? "").localeCompare(String(a.queued_at ?? "")));
    return { ok: true, ready: true, items };
  } catch (e) {
    return { ok: false, ready: true, items: [], error: e instanceof Error ? e.message : "فشل تحميل طابور طلبات." };
  }
}

/** The email went out — stamp the batch so it leaves the queue. */
export async function markTalabatSent(productIds: string[]): Promise<{ ok: boolean; marked: number; error?: string }> {
  if (!(await isSignedIn())) return { ok: false, marked: 0, error: "Not signed in." };
  const ids = [...new Set(productIds)].filter(Boolean).slice(0, 1000);
  if (!ids.length) return { ok: false, marked: 0, error: "ما في منتجات محددة." };
  try {
    const admin = createAdminClient();
    let by = "";
    try { by = (await createClient().auth.getUser()).data.user?.email ?? ""; } catch { /* keep empty */ }
    const { error, count } = await admin
      .from("talabat_queue")
      .update({ sent_at: new Date().toISOString(), sent_by: by || "owner" }, { count: "exact" })
      .in("product_id", ids)
      .is("sent_at", null);
    if (error) return { ok: false, marked: 0, error: error.message };
    revalidatePath("/import-export/talabat-sync");
    return { ok: true, marked: count ?? ids.length };
  } catch (e) {
    return { ok: false, marked: 0, error: e instanceof Error ? e.message : "فشل تعليم الإرسال." };
  }
}

/** READ-ONLY: diff Talabat's uploaded export rows against our catalog. */
export async function computeTalabatDiff(rows: Record<string, unknown>[]): Promise<TalabatDiff> {
  if (!(await isSignedIn())) return { ...EMPTY_DIFF, error: "Not signed in." };
  if (!rows?.length) return { ...EMPTY_DIFF, error: "الملف فاضي — ما فيه صفوف." };

  try {
    const sb = await createClient();
    let prods: Record<string, any>[];
    try {
      prods = await pageAll((from, to) => sb.from("products").select("id, sku, barcode, name_en, name_ar, approval, image_url, price, discount_price").range(from, to));
    } catch {
      // barcode column may not exist on older installs.
      prods = await pageAll((from, to) => sb.from("products").select("id, sku, name_en, name_ar, approval, image_url, price, discount_price").range(from, to));
    }
    const parents = new Set<string>();
    try {
      const vars = await pageAll<{ parent_product_id: string }>(
        (from, to) => sb.from("product_variants").select("parent_product_id").range(from, to));
      for (const v of vars) if (v.parent_product_id) parents.add(v.parent_product_id);
    } catch { /* no variants table → nothing excluded */ }

    const ours: TalabatOurRow[] = prods.map((p) => ({
      id: p.id, sku: p.sku ?? null, barcode: p.barcode ?? null,
      name_en: p.name_en ?? null, name_ar: p.name_ar ?? null,
      approval: p.approval ?? null, hasVariants: parents.has(p.id),
      image_url: p.image_url ?? null,
      price: p.price ?? null, discount_price: p.discount_price ?? null,
    }));
    return diffTalabat(ours, rows.slice(0, 20000));
  } catch (e) {
    return { ...EMPTY_DIFF, error: e instanceof Error ? e.message : "Diff failed." };
  }
}

export interface TalabatPackage {
  ok: boolean;
  error?: string;
  headers: string[];                      // exact Talabat column order
  rows: Record<string, string>[];         // sheet rows, ready for xlsx
  skus: string[];                         // for the images ZIP request
  splitProducts: number;                  // option products that became N rows
  noPrice: { sku: string; name_en: string }[];  // final rows with an empty/zero price
  noImage: { sku: string; name_en: string }[];
  emptyDesc: { sku: string; name_en: string }[];
  emailText: string;
}

/**
 * Build the "add these products" sheet rows (exact Talabat 10-column format)
 * for the given missing products. Pure data back to the client — the browser
 * writes the .xlsx and requests the images ZIP.
 */
export async function buildTalabatPackage(productIds: string[]): Promise<TalabatPackage> {
  const empty = { headers: TALABAT_HEADERS as string[], rows: [], skus: [], splitProducts: 0, noPrice: [], noImage: [], emptyDesc: [], emailText: "" };
  if (!(await isSignedIn())) return { ok: false, error: "Not signed in.", ...empty };
  const ids = [...new Set(productIds)].filter(Boolean).slice(0, 2000);
  if (!ids.length) return { ok: false, error: "ما في منتجات محددة.", ...empty };

  try {
    const sb = await createClient();
    const prods: Record<string, any>[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      let sel = "id, sku, barcode, price, discount_price, name_en, name_ar, main_category, description_en, description_ar, image_filename, image_url";
      let { data, error } = await sb.from("products").select(sel).in("id", ids.slice(i, i + 200));
      if (error) {
        sel = "id, sku, price, discount_price, name_en, name_ar, main_category, description_en, description_ar, image_filename, image_url";
        ({ data, error } = await sb.from("products").select(sel).in("id", ids.slice(i, i + 200)));
      }
      if (error) return { ok: false, error: error.message, ...empty };
      prods.push(...(data ?? []));
    }

    // Shopify-imported products have image_url but no image_filename — derive
    // the sheet name from the SKU so the sheet and the images ZIP agree.
    for (const p of prods) p.image_filename = imageFileFor(p.sku, p.image_filename, p.image_url);

    // Options → one standalone row per option ({sku}-{N}, name suffixed with
    // the option): Talabat rejects variant products, so each option ships solo.
    const variants: Record<string, any>[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      try {
        const { data } = await sb
          .from("product_variants")
          .select("parent_product_id, variant_name, sku, price")
          .in("parent_product_id", ids.slice(i, i + 200));
        variants.push(...(data ?? []));
      } catch { /* no variants table → all rows stay simple */ }
    }

    const built = buildTalabatRows(prods, variants);
    // Final safety net on the ACTUAL sheet rows (covers split rows too):
    // anything without a positive price gets called out before sending.
    const noPrice = (built.rows as Record<string, string>[])
      .filter((r) => !(Number(r["Price (QAR)"]) > 0))
      .map((r) => ({ sku: String(r["SKU"] ?? ""), name_en: String(r["Product Name EN"] ?? "") }));
    return {
      ok: true,
      headers: TALABAT_HEADERS as string[],
      rows: built.rows as Record<string, string>[],
      skus: prods.map((p) => String(p.sku ?? "")).filter(Boolean),
      splitProducts: Number(built.stats.withVariants) || 0,
      noPrice,
      noImage: built.stats.noImage as { sku: string; name_en: string }[],
      emptyDesc: built.stats.stillEmpty as { sku: string; name_en: string }[],
      emailText: talabatEmailText(built.rows.length),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Package failed.", ...empty };
  }
}

// ---- Verify staff entries against the platform's export --------------------------
// The platform file is the ground truth: every catalog-change task is checked
// against it. A done-task whose entry is missing/wrong REOPENS with an ❌
// comment naming the problem; matching entries get a ✅ comment (and an open
// task whose entry already landed is auto-closed — the work is proven done).

export interface VerifySummary {
  ok: boolean;
  error?: string;
  checked: number;
  confirmed: number;
  reopened: number;
  autoClosed: number;
  flagged: { title: string; detail: string }[];
}

const V_EMPTY = { checked: 0, confirmed: 0, reopened: 0, autoClosed: 0, flagged: [] as { title: string; detail: string }[] };

export async function verifyCatalogEntries(rows: Record<string, unknown>[]): Promise<VerifySummary> {
  if (!(await isSignedIn())) return { ok: false, error: "Not signed in.", ...V_EMPTY };
  if (!rows?.length) return { ok: false, error: "الملف فاضي.", ...V_EMPTY };

  try {
    const admin = createAdminClient();
    const key = (v: unknown) => String(v ?? "").toLowerCase().normalize("NFKC").replace(/[’']/g, "").replace(/["،,.\-–—]/g, " ").replace(/\s+/g, " ").trim();

    // Index THEIR file: skus (exact + split-base), names, and prices.
    const cols = detectTalabatColumns(Object.keys(rows[0] ?? {}));
    if (!cols.sku && !cols.nameEn && !cols.nameAr) return { ok: false, error: "ما تعرّفت على أعمدة الملف.", ...V_EMPTY };
    const skus = new Set<string>();
    const bases = new Set<string>();
    const names = new Set<string>();
    const priceBySku = new Map<string, number>();
    const priceByName = new Map<string, number>();
    for (const r of rows.slice(0, 20000)) {
      const sk = key(cols.sku ? r[cols.sku] : "");
      const nm = key(cols.nameEn ? r[cols.nameEn] : "") || key(cols.nameAr ? r[cols.nameAr] : "");
      const pr = cols.price ? Number(r[cols.price]) : NaN;
      if (sk) { skus.add(sk); bases.add(baseSku(cols.sku ? r[cols.sku] : "")); if (Number.isFinite(pr) && pr > 0) priceBySku.set(sk, pr); }
      if (nm) { names.add(nm); if (Number.isFinite(pr) && pr > 0 && !priceByName.has(nm)) priceByName.set(nm, pr); }
    }
    const idx = {
      hasSku: (v: string) => skus.has(key(v)) || bases.has(baseSku(v)) || skus.has(baseSku(v)),
      hasName: (v: string) => names.has(key(v)),
      priceFor: (sk: string, nm: string) => priceBySku.get(key(sk)) ?? priceByName.get(key(nm)) ?? null,
    };

    // Catalog-change tasks from the last 45 days.
    const sinceIso = new Date(Date.now() - 45 * 24 * 3600_000).toISOString();
    const { data: tData, error: tErr } = await admin
      .from("staff_tasks")
      .select("id, title, status, product_id, payload, assigned_name")
      .eq("kind", "catalog")
      .gte("created_at", sinceIso)
      .in("status", ["open", "in_progress", "done"])
      .limit(400);
    if (tErr) {
      if (/kind|payload/i.test(tErr.message)) return { ok: false, error: "شغّل supabase/catalog_change_tasks.sql أولًا.", ...V_EMPTY };
      return { ok: false, error: tErr.message, ...V_EMPTY };
    }
    type TRow = { id: string; title: string; status: string; product_id: string | null; payload: any; assigned_name: string | null };
    const tasks = ((tData ?? []) as TRow[]).filter((t) => t.payload?.snapshot);
    if (!tasks.length) return { ok: true, ...V_EMPTY };

    // Current catalog values (the platform must match NOW, not change-time).
    const ids = [...new Set(tasks.map((t) => t.product_id).filter(Boolean))] as string[];
    const current = new Map<string, { sku: string | null; name_en: string | null; price: number | null }>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await admin.from("products").select("id, sku, name_en, price, discount_price").in("id", ids.slice(i, i + 200));
      for (const r of (data ?? []) as any[]) {
        const eff = Number(r.discount_price) > 0 ? Number(r.discount_price) : Number(r.price) > 0 ? Number(r.price) : null;
        current.set(r.id, { sku: r.sku ?? null, name_en: r.name_en ?? null, price: eff });
      }
    }

    let confirmed = 0, reopened = 0, autoClosed = 0, checked = 0;
    const flagged: { title: string; detail: string }[] = [];
    for (const t of tasks) {
      const snap = t.payload.snapshot as Record<string, unknown>;
      const cur = t.product_id ? current.get(t.product_id) : undefined;
      const lite: VerifyTaskLite = {
        id: t.id, status: t.status, action: String(t.payload.action ?? "update"),
        sku: (cur?.sku ?? (snap.sku as string) ?? null) || null,
        name_en: (cur?.name_en ?? (snap.name_en as string) ?? null) || null,
        price: cur?.price ?? null,
      };
      const v = verdictForTask(lite, idx);
      if (v.status === "skipped") continue;
      checked++;

      const comment = async (body: string) => {
        try { await insertComment(admin, { taskId: t.id, role: "manager", author: "التحقق الآلي 🕵️", body }); } catch { /* best-effort */ }
      };

      if (v.status === "confirmed") {
        confirmed++;
        if (t.status !== "done") {
          // Entry already landed on the platform — the work is proven done.
          await admin.from("staff_tasks").update({ status: "done", completed_at: new Date().toISOString(), completed_by: "auto-verify" }).eq("id", t.id);
          await comment(`✅ ${v.detail} — قفلت المهمة تلقائيًا.`);
          autoClosed++;
        }
        continue;
      }
      if (v.reopen) {
        await admin.from("staff_tasks").update({ status: "open", completed_at: null, completed_by: null }).eq("id", t.id);
        await comment(`❌ ${v.detail}`);
        reopened++;
        flagged.push({ title: t.title, detail: v.detail });
      }
    }

    revalidatePath("/tasks");
    return { ok: true, checked, confirmed, reopened, autoClosed, flagged };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Verification failed.", ...V_EMPTY };
  }
}
