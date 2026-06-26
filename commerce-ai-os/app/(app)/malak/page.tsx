// ملاك — شاشة واحدة: لوحة Mission Control (HUD) + الكرة + المحادثة والصوت معًا.
import type { Metadata } from "next";
import { Tajawal } from "next/font/google";
import MalakClient from "./MalakClient";
import { getMalakKpis } from "@/lib/dashboard";

const tajawal = Tajawal({ subsets: ["arabic", "latin"], weight: ["400", "500", "700", "800"], display: "swap" });

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ملاك — Mission Control" };

export default async function Page() {
  const kpis = await getMalakKpis();
  return (
    <div dir="rtl" className={`${tajawal.className} min-h-full w-full overflow-x-hidden p-3 text-slate-100 sm:p-5`} style={{ background: "#020510" }}>
      <MalakClient kpis={kpis} />
    </div>
  );
}
