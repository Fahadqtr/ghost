// Download the Beauty Rewards customer list as a real .xlsx file (Arabic-safe,
// opens straight in Excel). Uses the xlsx package already in the project.
//
// D-2 — OWNER-ONLY, and it must stay that way. This is a BULK PII EXPORT: every
// loyalty customer's name and phone number in one file, read through the
// service-role helper, so RLS constrains nothing. The header said "Admin-only"
// while the code accepted any Supabase session; under the owner's policy staff
// may look a customer up for customer service, never download the whole list.
import { createRequire } from "node:module";
import { requireOwner } from "@/lib/malak/authz";
import { listCustomers, STAMPS_REQUIRED } from "@/lib/loyalty/rewards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const owner = await requireOwner();
  if (!owner.ok) return new Response(owner.error, { status: owner.status });

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
