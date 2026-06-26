// الشاشة الرئيسية لملاك = لوحة Mission Control (JARVIS HUD ببيانات حقيقية).
// المحادثة الكاملة في /malak/chat. dynamic لمنع التخزين المؤقت.
import type { Metadata } from "next";
import MalakHud from "./MalakHud";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ملاك — Mission Control" };

export default function Page() {
  return <MalakHud />;
}
