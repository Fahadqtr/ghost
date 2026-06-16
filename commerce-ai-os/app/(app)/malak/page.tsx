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
    // -m-* يلغي حشو الـmain لتمتدّ الخلفية الغامقة، ثم نعيد الحشو داخليًا.
    <div dir="rtl" className={`${tajawal.className} -m-4 min-h-full bg-[#0B1020] p-4 text-white sm:-m-6 sm:p-6`}>
      <MalakClient kpis={kpis} />
    </div>
  );
}
