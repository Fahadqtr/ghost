"use client";

// UX.1A — long-value cell renderer.
//
// Clamps a long suggested/current value to CLAMP_LINES lines with an ellipsis and
// an expand/collapse toggle, so one big value never blows up row height. NO data
// is truncated: the full text is always in the DOM (title tooltip + expand), and
// copy-to-clipboard always copies the complete value. The "needs a toggle"
// decision is the pure, tested isExpandableText heuristic.

import { useState } from "react";
import { CLAMP_LINES, isExpandableText } from "@/lib/ui/text";

export default function ClampText({
  text,
  dir,
  className = "",
}: {
  text: string | null | undefined;
  dir?: "ltr" | "rtl" | "auto";
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const value = typeof text === "string" ? text : "";

  if (value.trim() === "") return <span className="text-slate-400">—</span>;

  const expandable = isExpandableText(value);

  const clampStyle: React.CSSProperties =
    expandable && !expanded
      ? { display: "-webkit-box", WebkitLineClamp: CLAMP_LINES, WebkitBoxOrient: "vertical", overflow: "hidden" }
      : {};

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — no-op (the value is still visible/expandable) */
    }
  }

  return (
    <div className={`group/clamp space-y-1 ${className}`}>
      <div
        dir={dir}
        title={value}
        style={clampStyle}
        className="whitespace-pre-wrap break-words text-xs leading-snug"
      >
        {value}
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted">
        {expandable ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="rounded px-1 text-brand hover:underline"
            aria-expanded={expanded}
          >
            {expanded ? "▲ طيّ" : "▼ عرض الكل"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={copy}
          className="rounded px-1 text-slate-500 hover:text-ink hover:underline"
          aria-label="نسخ النص"
        >
          {copied ? "✓ نُسخ" : "⧉ نسخ"}
        </button>
      </div>
    </div>
  );
}
