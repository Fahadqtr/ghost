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
    <div dir="rtl" className={`${tajawal.className} relative min-h-full w-full overflow-x-hidden p-3 text-slate-100 sm:p-5`} style={{ background: "#040a14" }}>
      {/* faint grid */}
      <div className="pointer-events-none absolute inset-0 opacity-[0.06]" style={{
        backgroundImage: "linear-gradient(rgba(120,175,215,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(120,175,215,0.6) 1px, transparent 1px)",
        backgroundSize: "46px 46px",
      }} />
      {/* corner frame brackets */}
      {["left-2 top-2 border-l-2 border-t-2", "right-2 top-2 border-r-2 border-t-2", "left-2 bottom-2 border-l-2 border-b-2", "right-2 bottom-2 border-r-2 border-b-2"].map((c) => (
        <span key={c} aria-hidden className={`pointer-events-none absolute z-10 h-6 w-6 ${c}`} style={{ borderColor: "rgba(120,175,215,0.45)" }} />
      ))}
      <div className="relative z-10">
        <MalakClient kpis={kpis} />
      </div>
    </div>
  );
}
