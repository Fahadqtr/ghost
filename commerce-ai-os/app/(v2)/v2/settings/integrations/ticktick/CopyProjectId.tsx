"use client";

// Tiny client island: copies a TickTick Project ID to the clipboard. It receives
// ONLY the public project id (not a secret) and imports no server module — so no
// token or server-only code ever reaches the browser through it.

import { useState } from "react";

export default function CopyProjectId({ projectId }: { projectId: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(projectId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (e.g. insecure context) — stay silent, no leak
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="btn-ghost text-xs"
      aria-label={`نسخ Project ID: ${projectId}`}
    >
      {copied ? "تم النسخ ✓" : "نسخ Project ID"}
    </button>
  );
}
