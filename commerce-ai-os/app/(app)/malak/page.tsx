// مسار ملاك داخل إطار الداشبورد (سايدبار + توببار). كان سابقًا صفحة مستقلة.
// dynamic لمنع التخزين المؤقت حتى يعكس كل تحميل آخر بناء.
import type { Metadata } from "next";
import { Tajawal } from "next/font/google";
import MalakClient from "./MalakClient";

const tajawal = Tajawal({ subsets: ["arabic", "latin"], weight: ["400", "500", "700", "800"], display: "swap" });

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ملاك — Malak AI" };

export default function Page() {
  return (
    <div dir="rtl" className={`${tajawal.className} absolute inset-0`}>
      <MalakClient />
    </div>
  );
}
