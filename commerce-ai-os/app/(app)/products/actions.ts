"use server";

import Anthropic from "@anthropic-ai/sdk";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logCatalogTask } from "@/lib/tasks/catalog-log";
import { queueForTalabat } from "@/lib/talabat/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSignedIn } from "@/lib/auth/requireUser";

// The product create/edit save cores (row projection, inventory sync, the
// id-preserving variant sync) live in lib/products/product-save.ts and are used
// by the V2 editor's own server actions. The legacy createProduct/updateProduct
// actions that once called them here were retired in UX.4E-9C once the legacy
// form (components/ProductForm.tsx) was removed. The input-shape types stay
// re-exported for the approval/delete workflows and any external callers.
export type { ProductInput, VariantInput } from "@/lib/products/product-save";

// --- actions --------------------------------------------------------------

// Quick approve/reject from the list or dashboard (no full form). Empty -> null.
// Optional reason (written to rejection_reason) records WHY.
const APPROVAL_OPTS = new Set(["Approved", "Rejected", "SentAI", ""]);
export async function setProductApproval(id: string, approval: string, reason?: string) {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  if (!id) return { error: "Missing product id." };
  if (!APPROVAL_OPTS.has(approval)) return { error: `Invalid approval "${approval}".` };
  const supabase = createClient();
  const patch: Record<string, unknown> = { approval: approval === "" ? null : approval };
  if (reason !== undefined) patch.rejection_reason = reason.trim() || null;
  // Full row: an APPROVAL task must carry everything the employee copies into
  // the manual platforms (names, prices, descriptions, category, photo).
  const { data: beforeRow } = await supabase.from("products").select("*").eq("id", id).maybeSingle();
  const { error } = await supabase.from("products").update(patch).eq("id", id);
  if (error) return { error: error.message };
  if (String(beforeRow?.approval ?? "") !== String(approval)) {
    if (approval === "Approved") {
      // Newly approved → the "add it to the platforms" task, full details.
      // The employee enters it in سنونو/رفيق then marks the task done; the
      // platform-export verification confirms it later. Talabat goes by the
      // owner's email instead — the product waits in talabat_queue.
      await logCatalogTask({
        action: "create", productId: id,
        snapshot: { ...(beforeRow ?? {}), approval: "Approved" } as Record<string, unknown>,
        note: "✅ المنتج انعتمد — أضِفه في المنصات اليدوية بكل بياناته، وبعد الإضافة علّم المهمة «تم».",
      });
      try { await queueForTalabat(createAdminClient(), id); } catch { /* best-effort */ }
    } else {
      await logCatalogTask({
        action: "approval", productId: id, snapshot: (beforeRow ?? {}) as Record<string, unknown>,
        changes: [{ field: "approval", old: String(beforeRow?.approval ?? "—"), new: approval || "—" }],
      });
    }
  }
  revalidatePath("/products");
  revalidatePath("/dashboard");
  revalidatePath(`/products/${id}`);
  return { ok: true };
}

// Inline product status toggle (Active / Draft) — straight from the catalog,
// no need to open the product editor.
export async function setProductStatus(id: string, status: string): Promise<{ ok?: true; error?: string }> {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  if (!id) return { error: "Missing product id." };
  const value = status === "Active" ? "Active" : "Draft";
  const supabase = createClient();
  const { error } = await supabase.from("products").update({ platform_status: value }).eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/products");
  revalidatePath(`/products/${id}`);
  return { ok: true };
}

// Bulk approve/reject (e.g. reject everything Snoonu marked unavailable).
// Optional `reason` records WHY (written to notes), e.g. "بسبب الصورة".
export async function setProductsApproval(ids: string[], approval: string, reason?: string) {
  if (!(await isSignedIn())) return { error: "Not signed in.", updated: 0 };
  const list = (ids ?? []).filter(Boolean);
  if (list.length === 0) return { error: "No products selected.", updated: 0 };
  if (!APPROVAL_OPTS.has(approval)) return { error: `Invalid approval "${approval}".`, updated: 0 };
  const supabase = createClient();
  const value = approval === "" ? null : approval;
  const patch: Record<string, unknown> = { approval: value };
  // Record/clear the rejection reason on its own column.
  if (reason !== undefined) patch.rejection_reason = reason.trim() || null;
  let updated = 0, failed = 0;
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const { error, count } = await supabase
      .from("products").update(patch, { count: "exact" }).in("id", chunk);
    if (error) failed += chunk.length; else updated += count ?? chunk.length;
  }
  if (updated > 0) {
    const { data: sample } = await supabase.from("products").select("name_en, sku").in("id", list.slice(0, 6));
    const names = ((sample ?? []) as { name_en: string | null; sku: string | null }[])
      .map((r) => `${r.name_en ?? ""}${r.sku ? ` (${r.sku})` : ""}`).join("، ");
    await logCatalogTask({
      action: "bulk",
      note: `تغيير حالة ${updated} منتج إلى «${value ?? "بدون"}»${names ? ` — منها: ${names}${list.length > 6 ? "…" : ""}` : ""}`,
    });
  }
  revalidatePath("/products");
  revalidatePath("/dashboard");
  return { ok: failed === 0, updated, failed };
}

// Turn selected catalog products into manual "add to platforms" tasks — one
// task per product, each carrying its FULL snapshot and the exact platforms the
// manager picked, so an employee can add it by hand on those platforms and tick
// them off. Best-effort logging never blocks; returns how many tasks opened.
export async function createAddToPlatformTasks(
  productIds: string[],
  platforms: string[],
): Promise<{ ok?: true; created: number; error?: string }> {
  if (!(await isSignedIn())) return { error: "Not signed in.", created: 0 };
  const ids = [...new Set((productIds ?? []).filter(Boolean))];
  const plats = [...new Set((platforms ?? []).map((p) => String(p ?? "").trim()).filter(Boolean))];
  if (ids.length === 0) return { error: "No products selected.", created: 0 };
  if (plats.length === 0) return { error: "No platforms selected.", created: 0 };

  const supabase = createClient();
  let created = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data: rows } = await supabase.from("products").select("*").in("id", chunk);
    for (const row of (rows ?? []) as Record<string, unknown>[]) {
      await logCatalogTask({
        action: "add",
        productId: String(row.id),
        snapshot: row,
        platforms: plats,
        extraPayload: { platforms: plats },
      });
      created += 1;
    }
  }
  if (created > 0) revalidatePath("/tasks");
  return { ok: true, created };
}

export interface MatchedProduct { id: string; sku: string | null; name_en: string | null; approval: string | null }

// Match pasted lines (Snoonu names or SKUs) to catalog products, so the user can
// bulk-reject the products Snoonu rejected (that status isn't in the export).
export async function matchProductsByText(text: string): Promise<{ error?: string; matched: MatchedProduct[]; unmatched: string[] }> {
  if (!(await isSignedIn())) return { error: "Not signed in.", matched: [], unmatched: [] };
  const lines = [...new Set((text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
  if (lines.length === 0) return { matched: [], unmatched: [] };

  const supabase = createClient();
  const all: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await supabase.from("products").select("id, sku, name_en, name_ar, approval").range(f, f + 999);
    if (error) return { error: error.message, matched: [], unmatched: [] };
    all.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  // Normalize for matching: lowercase, drop apostrophes/quotes (straight vs
  // curly "Men's"), and collapse spaces — so OCR/paste text matches the catalog.
  const norm = (s: string) =>
    String(s ?? "").toLowerCase().replace(/[’‘'`´]/g, "").replace(/\s+/g, " ").trim();
  const matched: MatchedProduct[] = [];
  const seen = new Set<string>();
  const unmatched: string[] = [];
  for (const line of lines) {
    // strip trailing ellipsis from truncated names copied out of the Snoonu app
    const ln = norm(line).replace(/[.…]+$/, "").trim();
    if (!ln) continue;
    const hits = all.filter((p) =>
      norm(p.sku) === ln ||
      (p.name_en && norm(p.name_en).includes(ln)) ||
      (p.name_ar && norm(p.name_ar).includes(ln))
    );
    if (hits.length === 0) { unmatched.push(line); continue; }
    for (const h of hits) {
      if (!seen.has(h.id)) { seen.add(h.id); matched.push({ id: h.id, sku: h.sku, name_en: h.name_en, approval: h.approval }); }
    }
  }
  return { matched, unmatched };
}

// Read Snoonu "Drafts & Approvals" screenshots and extract the REJECTED product
// names (vision via Claude). Needs ANTHROPIC_API_KEY (set on Vercel).
export async function extractRejectedFromImages(
  images: { media_type: string; data: string }[]
): Promise<{ error?: string; names: string[] }> {
  if (!(await isSignedIn())) return { error: "Not signed in.", names: [] };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: "ميزة قراءة الصور غير مفعّلة (ANTHROPIC_API_KEY).", names: [] };
  const imgs = (images ?? []).filter((i) => i?.data && i?.media_type).slice(0, 8);
  if (imgs.length === 0) return { error: "ما في صورة.", names: [] };

  const PROMPT =
    "هذي لقطات شاشة من تطبيق سنونو (قسم Drafts & Approvals). كل منتج له اسم وشارة حالة " +
    "(Rejected / Draft / Awaiting Approval). استخرج فقط أسماء المنتجات الإنجليزية اللي حالتها " +
    "Rejected. بعض الأسماء مقطوعة بـ '…' — رجّعها كما هي. أجب بمصفوفة JSON من النصوص فقط، بدون أي كلام آخر.";

  try {
    const client = new Anthropic({ apiKey });
    const content: any[] = imgs.map((im) => ({
      type: "image",
      source: { type: "base64", media_type: im.media_type, data: im.data },
    }));
    content.push({ type: "text", text: PROMPT });
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{ role: "user", content }],
    });
    const text = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const m = text.match(/\[[\s\S]*\]/);
    let names: string[] = [];
    if (m) { try { names = JSON.parse(m[0]).filter((x: any) => typeof x === "string" && x.trim()); } catch {} }
    return { names: [...new Set(names.map((n) => n.trim()))] };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "فشل قراءة الصورة.", names: [] };
  }
}

export async function deleteProduct(id: string) {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  const supabase = createClient();
  // Full snapshot BEFORE deleting — the auto-task carries it so the assignee
  // can remove the product from the manual platforms too.
  const { data: doomed } = await supabase.from("products").select("*").eq("id", id).maybeSingle();
  // Capture the options BEFORE deleting the variant rows, so the removal task
  // still lists every option to pull off the manual platforms.
  const { data: doomedVariants } = await supabase
    .from("product_variants")
    .select("variant_name, sku, barcode, color, size, price")
    .eq("parent_product_id", id);
  // INV.6A — every numeric dependent is removed by ON DELETE CASCADE: inventory
  // → products, product_variants → products, shelf_stock → inventory,
  // variant_shelf_stock → product_variants, channel_products → products. Deleting
  // the product row is therefore sufficient and atomic in the database; no manual
  // child-delete chain (no stranded shelf rows). Fail-closed on the delete error.
  const { error } = await supabase.from("products").delete().eq("id", id);
  if (error) return { error: error.message };
  await logCatalogTask({ action: "delete", productId: id, snapshot: { ...(doomed ?? {}), variants: doomedVariants ?? [] } as Record<string, unknown> });
  revalidatePath("/products");
  revalidatePath("/inventory");
  redirect("/products");
}
