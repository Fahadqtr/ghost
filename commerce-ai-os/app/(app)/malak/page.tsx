// مسار ملاك داخل إطار الداشبورد (سايدبار + توببار). لوحة Commerce AI OS:
// هيرو المختبر 3D + بطاقات KPI حيّة + المحادثة. dynamic لمنع التخزين المؤقت.
import type { Metadata } from "next";
import { Tajawal } from "next/font/google";
import MalakClient from "./MalakClient";
import { getMalakKpis } from "@/lib/dashboard";

const tajawal = Tajawal({ subsets: ["arabic", "latin"], weight: ["400", "500", "700", "800"], display: "swap" });

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ملاك — Malak AI" };

export default async function Page() {
  const kpis = await getMalakKpis();
  return (
    // الـmain بدون حشو لمسار ملاك، فالخلفية الغامقة ممتدّة edge-to-edge بدون هوامش سالبة.
    <div dir="rtl" className={`${tajawal.className} min-h-full w-full overflow-x-hidden bg-[#0B1020] p-4 text-white sm:p-6`}>
      <MalakClient kpis={kpis} />
    </div>
  );
}
