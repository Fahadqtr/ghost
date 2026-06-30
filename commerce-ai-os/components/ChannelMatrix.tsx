"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { CHANNEL_STATUSES } from "@/lib/constants";
import { setChannelStatus } from "@/app/(app)/channels/actions";
import type { Locale } from "@/lib/i18n";

const PAGE_SIZE = 50;

export interface MatrixChannel {
  id: string;
  name: string;
  supports_variants: boolean | null;
}
export interface MatrixProduct {
  id: string;
  name_en: string | null;
  sku: string | null;
}

const statusStyle: Record<string, string> = {
  Active: "bg-green-100 text-green-700 border-green-200",
  Draft: "bg-amber-100 text-amber-700 border-amber-200",
  "Not Listed": "bg-slate-100 text-slate-500 border-slate-200",
};

export default function ChannelMatrix({
  products,
  channels,
  initialStatuses,
  locale = "ar",
}: {
  products: MatrixProduct[];
  channels: MatrixChannel[];
  // key = `${productId}:${channelId}` -> status
  initialStatuses: Record<string, string>;
  locale?: Locale;
}) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [statuses, setStatuses] = useState(initialStatuses);
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  // Disambiguate duplicate channel names (e.g. two "Snoonu" storefronts).
  const channelLabels = useMemo(() => {
    const counts: Record<string, number> = {};
    channels.forEach((c) => (counts[c.name] = (counts[c.name] ?? 0) + 1));
    const seen: Record<string, number> = {};
    return channels.map((c) => {
      if (counts[c.name] > 1) {
        seen[c.name] = (seen[c.name] ?? 0) + 1;
        return `${c.name} #${seen[c.name]}`;
      }
      return c.name;
    });
  }, [channels]);

  function change(productId: string, channelId: string, status: string) {
    const key = `${productId}:${channelId}`;
    setStatuses((s) => ({ ...s, [key]: status })); // optimistic
    startTransition(async () => {
      const res = await setChannelStatus(productId, channelId, status);
      if (res?.error) alert(res.error);
    });
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return products;
    return products.filter(
      (p) =>
        (p.name_en ?? "").toLowerCase().includes(needle) ||
        (p.sku ?? "").toLowerCase().includes(needle)
    );
  }, [products, q]);

  useEffect(() => { setPage(1); }, [q]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const start = (current - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);

  if (products.length === 0) {
    return <p className="text-sm text-slate-400">{L("لا توجد منتجات بعد. أضف منتجات لنشرها على القنوات.", "No products yet. Add products to publish them to channels.")}</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          className="input sm:max-w-xs"
          placeholder={L("ابحث بالاسم أو الـ SKU…", "Search by name or SKU…")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="text-sm text-muted sm:ml-auto">
          {filtered.length === products.length
            ? L(`${products.length} منتج`, `${products.length} products`)
            : L(`${filtered.length} من ${products.length}`, `${filtered.length} of ${products.length}`)}
        </span>
      </div>

      {/* Cards (mobile) */}
      <div className="space-y-3 md:hidden">
        {visible.map((p) => (
          <div key={p.id} className="card space-y-2 p-3">
            <div>
              <div className="font-medium text-ink">{p.name_en ?? "—"}</div>
              {p.sku ? <div className="text-xs text-muted">{p.sku}</div> : null}
            </div>
            <div className="space-y-2">
              {channels.map((c, i) => {
                const key = `${p.id}:${c.id}`;
                const value = statuses[key] ?? "Not Listed";
                return (
                  <div key={c.id} className="flex items-center justify-between gap-2">
                    <span className="text-sm text-slate-600">
                      {channelLabels[i]}
                      {c.supports_variants === false ? <span className="ml-1 text-[10px] text-slate-400">{L("(بدون خيارات)", "(no variants)")}</span> : null}
                    </span>
                    <select
                      disabled={pending}
                      value={value}
                      onChange={(e) => change(p.id, c.id, e.target.value)}
                      className={`rounded-md border px-2 py-1 text-xs ${statusStyle[value] ?? statusStyle["Not Listed"]}`}
                    >
                      {CHANNEL_STATUSES.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Table (desktop / tablet) */}
      <div className="card hidden overflow-x-auto p-0 md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase text-muted">
              <th className="px-4 py-3 font-medium">{L("المنتج", "Product")}</th>
              {channels.map((c, i) => (
                <th key={c.id} className="px-4 py-3 font-medium">
                  {channelLabels[i]}
                  {c.supports_variants === false ? (
                    <span className="ml-1 font-normal text-[10px] lowercase text-slate-400">{L("(بدون خيارات)", "(no variants)")}</span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => (
              <tr key={p.id} className="border-b border-slate-100">
                <td className="px-4 py-3">
                  <div className="font-medium text-ink">{p.name_en ?? "—"}</div>
                  <div className="text-xs text-muted">{p.sku ?? ""}</div>
                </td>
                {channels.map((c) => {
                  const key = `${p.id}:${c.id}`;
                  const value = statuses[key] ?? "Not Listed";
                  return (
                    <td key={c.id} className="px-4 py-3">
                      <select
                        disabled={pending}
                        value={value}
                        onChange={(e) => change(p.id, c.id, e.target.value)}
                        className={`rounded-md border px-2 py-1 text-xs ${statusStyle[value] ?? statusStyle["Not Listed"]}`}
                      >
                        {CHANNEL_STATUSES.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length > PAGE_SIZE ? (
        <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
          <span className="text-sm text-muted">
            {L(
              `عرض ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} من ${filtered.length}`,
              `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length}`
            )}
          </span>
          <div className="flex items-center gap-2">
            <button className="btn-ghost px-3 py-1.5 text-sm disabled:opacity-40" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={current <= 1}>{L("→ السابق", "← Prev")}</button>
            <span className="text-sm text-slate-600">{L(`صفحة ${current} / ${totalPages}`, `Page ${current} / ${totalPages}`)}</span>
            <button className="btn-ghost px-3 py-1.5 text-sm disabled:opacity-40" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={current >= totalPages}>{L("التالي ←", "Next →")}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
