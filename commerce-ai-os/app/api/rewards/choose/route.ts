// Public: a customer who completed their card picks which prize they want.
// Guarded inside lib/loyalty (must be complete + prize must be active).
import { chooseReward } from "@/lib/loyalty/rewards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { phone?: string; prizeId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "صيغة الطلب غير صحيحة." }, { status: 400 });
  }
  if (!body.prizeId) return Response.json({ error: "اختاري جائزة." }, { status: 400 });

  try {
    const state = await chooseReward(body.phone ?? "", body.prizeId);
    return Response.json({ ok: true, state });
  } catch (e: any) {
    return Response.json({ error: e?.message ?? "تعذّرت العملية." }, { status: 400 });
  }
}
