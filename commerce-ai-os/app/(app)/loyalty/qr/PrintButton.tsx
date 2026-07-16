"use client";

export default function PrintButton() {
  return (
    <button
      data-no-print
      onClick={() => window.print()}
      className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
    >
      🖨️ طباعة
    </button>
  );
}
