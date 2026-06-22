"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createShelf, addSlot, deleteSlot, deleteShelf } from "@/app/(app)/inventory/actions";
import { compareSlot } from "@/lib/shelf";

export type Slot = { code: string; shelf: string };

export default function ShelvesManager({
  slots,
  counts,
}: {
  slots: Slot[];
  counts: Record<string, number>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const [newShelf, setNewShelf] = useState("");
  const [newCount, setNewCount] = useState("5");
  const [newSlot, setNewSlot] = useState("");

  // Group slots by shelf, sorted naturally.
  const grouped = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of slots) {
      const arr = m.get(s.shelf) ?? [];
      arr.push(s.code);
      m.set(s.shelf, arr);
    }
    for (const arr of m.values()) arr.sort(compareSlot);
    return Array.from(m.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [slots]);

  const run = (fn: () => Promise<{ error?: string } | { ok: boolean }>, ok?: string) =>
    start(async () => {
      const res = await fn();
      if (res && "error" in res && res.error) setMsg(res.error);
      else { setMsg(ok ?? null); router.refresh(); }
    });

  return (
    <div className="space-y-4">
      {msg && (
        <div className="card py-2 text-sm border-amber-200 bg-amber-50 text-amber-800">
          {msg}
          <button className="ml-3 text-xs underline" onClick={() => setMsg(null)}>dismiss</button>
        </div>
      )}

      {/* Add controls */}
      <div className="card flex flex-wrap items-end gap-4">
        <div className="flex items-end gap-2">
          <label className="text-sm">
            <div className="mb-1 text-muted">New shelf</div>
            <input
              className="input w-20 uppercase"
              placeholder="A"
              maxLength={2}
              value={newShelf}
              onChange={(e) => setNewShelf(e.target.value)}
            />
          </label>
          <label className="text-sm">
            <div className="mb-1 text-muted">Slots</div>
            <input
              className="input w-20"
              type="number"
              min={1}
              max={200}
              value={newCount}
              onChange={(e) => setNewCount(e.target.value)}
            />
          </label>
          <button
            className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
            disabled={pending || !newShelf.trim()}
            onClick={() =>
              run(() => createShelf(newShelf, Number(newCount) || 1), `Added shelf ${newShelf.toUpperCase()}.`)
            }
          >
            Create shelf
          </button>
        </div>

        <div className="flex items-end gap-2 sm:ml-auto">
          <label className="text-sm">
            <div className="mb-1 text-muted">Add one slot</div>
            <input
              className="input w-28 uppercase"
              placeholder="C7"
              value={newSlot}
              onChange={(e) => setNewSlot(e.target.value)}
            />
          </label>
          <button
            className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-50"
            disabled={pending || !newSlot.trim()}
            onClick={() => run(() => addSlot(newSlot), `Added slot ${newSlot.toUpperCase()}.`)}
          >
            Add slot
          </button>
        </div>
      </div>

      {/* Shelves */}
      {grouped.length === 0 ? (
        <div className="card py-10 text-center text-sm text-slate-400">
          No shelves yet — create your first shelf above (e.g. A with 5 slots → A1…A5).
        </div>
      ) : (
        <div className="space-y-3">
          {grouped.map(([shelf, codes]) => {
            const total = codes.reduce((s, c) => s + (counts[c] ?? 0), 0);
            return (
              <div key={shelf} className="card">
                <div className="mb-3 flex items-center justify-between">
                  <div className="font-medium text-ink">
                    Shelf {shelf} <span className="text-xs text-muted">· {codes.length} slots · {total} products</span>
                  </div>
                  <button
                    className="btn-ghost px-2 py-1 text-xs text-red-600"
                    disabled={pending}
                    onClick={() => {
                      if (confirm(`Delete shelf ${shelf} and all its slots?`)) run(() => deleteShelf(shelf));
                    }}
                  >
                    Delete shelf
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {codes.map((c) => (
                    <span key={c} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-sm">
                      <span className="font-mono font-medium">{c}</span>
                      <span className="text-xs text-muted">{counts[c] ?? 0}</span>
                      <button
                        className="text-slate-400 hover:text-red-600"
                        title="Delete slot"
                        disabled={pending}
                        onClick={() => run(() => deleteSlot(c))}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
