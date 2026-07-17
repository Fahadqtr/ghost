// Admin-only: download the Beauty Rewards customer list as a real .xlsx file
// (Arabic-safe, opens straight in Excel). Uses the xlsx package already in the
// project. Auth-gated by middleware + an explicit getUser() check.
import { createRequire } from "node:module";
import { createClient } from "@/lib/supabase/server";
import { listCustomers, STAMPS_REQUIRED } from "@/lib/loyalty/rewards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const {
    data: { user },
  } = await createClient().auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let rows: Awaited<ReturnType<typeof listCustomers>>;
  try {
    rows = await listCustomers();
  } catch (e: any) {
    return new Response(e?.message ?? "export failed", { status: 500 });
  }

  const header = [
    "الاسم",
    "رقم الجوال",
    "القلوب الحالية",
    "الهدف",
    "الهدايا المستبدلة",
    "جاهزة للاستبدال",
    "تاريخ التسجيل",
    "آخر نشاط",
  ];
  const aoa = [
    header,
    ...rows.map((r) => [
      r.name,
      r.phone,
      r.stamps,
      STAMPS_REQUIRED,
      r.cyclesCompleted,
      r.rewardReady ? "نعم" : "",
      r.createdAt?.slice(0, 10) ?? "",
      r.updatedAt?.slice(0, 10) ?? "",
    ]),
  ];

  const require = createRequire(import.meta.url);
  const XLSX = require("xlsx");
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 22 }, { wch: 16 }, { wch: 12 }, { wch: 8 },
    { wch: 14 }, { wch: 14 }, { wch: 13 }, { wch: 13 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "الزبائن");
  const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="loyalty-customers-${stamp}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
