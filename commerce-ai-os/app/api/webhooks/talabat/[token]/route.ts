import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseTalabatOrder } from "@/lib/talabat/order-compute";
import { parseTalabatOrderLines, buildTalabatDedupKey } from "@/lib/talabat/order-lines";
import { resolveTalabatOrder } from "@/lib/talabat/order-resolver";
import { buildTalabatDeductionPlan, sanitizeResolution } from "@/lib/talabat/deduction-plan";
import { evaluateDeductGate, isAutoDeductEnabled } from "@/lib/talabat/event-gate";
import { loadTalabatResolutionContext } from "@/lib/talabat/resolution-context";
import { loadStockSnapshots } from "@/lib/talabat/stock-snapshots";
import { processStoredTalabatOrder, handleScheduleFailure, handleUnexpectedProcessingFailure, type ProcessOrderDeps } from "@/lib/talabat/process-order";
import { logAuthoritativeStockTransition, logAuthoritativeVariantOnlyTransition } from "@/lib/inventory/transition";
import {
  handleTalabatWebhookPost,
  handleTalabatWebhookGet,
  constantTimeEqual,
} from "@/lib/talabat/webhook-core";

// Talabat / Delivery Hero ORDER webhook receiver. Register this URL in the
// Vendor Portal (Order Webhook Settings):
//   https://<app>/api/webhooks/talabat/<TALABAT_WEBHOOK_TOKEN>
// The token in the path is the shared secret. We validate it BEFORE reading the
// body, STORE the full raw payload + best-effort display fields, and ack 200
// quickly. Automatic stock deduction is CLOSED BY DEFAULT — it runs server-side
// (after the response) only when TALABAT_AUTO_DEDUCT_ENABLED === "true" and the
// event is in TALABAT_DEDUCT_EVENT_ALLOWLIST. All processing/deduction logic
// lives in the self-contained, unit-tested modules under lib/talabat.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clean(v: string | undefined): string { return String(v ?? "").trim().replace(/^["']|["']$/g, ""); }

function tokenOk(given: string): boolean {
  const want = clean(process.env.TALABAT_WEBHOOK_TOKEN);
  if (!want) return false; // missing secret → fail closed
  return constantTimeEqual(given, want);
}

/** Build the injected dependencies for the server-only processor. */
function buildProcessDeps(): ProcessOrderDeps {
  return {
    enabledFlag: process.env.TALABAT_AUTO_DEDUCT_ENABLED,
    allowlistRaw: process.env.TALABAT_DEDUCT_EVENT_ALLOWLIST,
    parseLines: parseTalabatOrderLines,
    buildDedupKey: buildTalabatDedupKey,
    resolveOrder: resolveTalabatOrder,
    buildPlan: buildTalabatDeductionPlan,
    sanitize: sanitizeResolution,
    evaluateGate: evaluateDeductGate,
    loadContext: loadTalabatResolutionContext,
    loadSnapshots: loadStockSnapshots,
    // INV.5 — best-effort authoritative transitions from the canonical sale result:
    // a parent product task once per product, and a variant-only task for a variant
    // whose parent did NOT cross zero (no duplicate parent tasks). Never totalStock.
    logTransitions: async (admin, { products, variants }) => {
      const parentCrossed = new Map<string, boolean>();
      for (const p of products) {
        const before = Number(p.before) || 0;
        const after = Number(p.after) || 0;
        const productId = String(p.productId ?? "");
        parentCrossed.set(productId, (before > 0 && after <= 0) || (before <= 0 && after > 0));
        await logAuthoritativeStockTransition(admin, { productId, before, after, actor: "طلبات — Talabat" });
      }
      for (const v of variants) {
        const productId = String(v.productId ?? "");
        if (parentCrossed.get(productId)) continue;
        await logAuthoritativeVariantOnlyTransition(admin, {
          productId,
          variantId: String(v.variantId ?? ""),
          variantName: v.variantSku ?? "",
          variantBefore: Number(v.before) || 0,
          variantAfter: Number(v.after) || 0,
          actor: "طلبات — Talabat",
        });
      }
    },
  };
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  // TOKEN FIRST — return 404 before touching the body, JSON, the admin client,
  // the DB, or scheduling. (webhook-core re-checks the token as defense-in-depth.)
  if (!tokenOk(String(token || ""))) return new Response("Not found", { status: 404 });

  // Header-derived event only (no body access yet).
  const headerEvent = req.headers.get("x-event-type") || req.headers.get("x-dh-event") || null;

  const result = await handleTalabatWebhookPost(
    {
      tokenOk,
      readBody: () => req.text().catch(() => ""),
      parseLines: (payload: any) => { const x = parseTalabatOrderLines(payload); return { orderCode: x.orderCode, event: x.event }; },
      parseDisplay: (payload: any) => {
        const p = parseTalabatOrder(payload);
        return { status: p.status, customerName: p.customerName, total: p.total, currency: p.currency, placedAt: p.placedAt, items: p.items };
      },
      insertOrder: async (row) => {
        try {
          const admin = createAdminClient();
          const { data, error } = await admin.from("talabat_orders").insert(row).select("id, processing_status").single();
          if (error || !data) return { id: null, error: true };
          return { id: String(data.id), error: false };
        } catch {
          return { id: null, error: true };
        }
      },
      isAutoDeductEnabled: () => isAutoDeductEnabled(process.env.TALABAT_AUTO_DEDUCT_ENABLED),
      schedule: (fn) => after(fn),
      processOrder: async (orderId: string) => {
        const admin = createAdminClient();
        return processStoredTalabatOrder(admin, orderId, buildProcessDeps());
      },
      handleScheduleFailure: async (orderId: string) => {
        const admin = createAdminClient();
        return handleScheduleFailure(admin, orderId, buildProcessDeps());
      },
      handleUnexpectedProcessingFailure: async (orderId: string) => {
        const admin = createAdminClient();
        return handleUnexpectedProcessingFailure(admin, orderId, buildProcessDeps());
      },
      log: (msg: string) => console.error(msg),
    },
    { token: String(token || ""), headerEvent },
  );

  return new Response(result.body, {
    status: result.status,
    headers: result.contentType ? { "Content-Type": result.contentType } : undefined,
  });
}

// A GET on the same URL is handy for a quick "is it reachable?" check.
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const result = handleTalabatWebhookGet({ tokenOk }, { token: String(token || "") });
  return new Response(result.body, {
    status: result.status,
    headers: result.contentType ? { "Content-Type": result.contentType } : undefined,
  });
}
