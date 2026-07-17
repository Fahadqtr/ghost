"use client";

import { useState } from "react";

// Copies the full pre-built product text (title, descriptions, codes, price,
// options…) to the clipboard. Text is assembled server-side and passed in.
export default function ProductCopyAll({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setOk(true);
      setTimeout(() => setOk(false), 1800);
    } catch {
      // Fallback for older browsers / insecure contexts.
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); setOk(true); setTimeout(() => setOk(false), 1800); } catch { /* ignore */ }
      ta.remove();
    }
  };
  return (
    <button type="button" onClick={copy} className="btn-ghost w-full px-3 py-2 text-sm sm:w-auto">
      {ok ? "✓ نُسخ كل التفاصيل" : "📋 نسخ كل التفاصيل"}
    </button>
  );
}
