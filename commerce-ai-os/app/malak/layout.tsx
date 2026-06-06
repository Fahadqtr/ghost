import type { Metadata } from "next";
import { Tajawal } from "next/font/google";

const tajawal = Tajawal({
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "700", "800"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "ملاك — Malak AI",
  description: "المديرة العامة الذكية لمتجر Malika's Universe Trading.",
};

// Full-screen immersive shell for Malak (no dashboard sidebar). RTL + dark.
export default function MalakLayout({ children }: { children: React.ReactNode }) {
  return (
    <div dir="rtl" className={`${tajawal.className} malak-root`}>
      {children}
    </div>
  );
}
