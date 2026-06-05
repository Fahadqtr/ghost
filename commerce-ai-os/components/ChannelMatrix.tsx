"use client";

import { useState, useTransition } from "react";
import { CHANNEL_STATUSES } from "@/lib/constants";
import { setChannelStatus } from "@/app/(app)/channels/actions";

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
}: {
  products: MatrixProduct[];
  channels: MatrixChannel[];
  // key = `${productId}:${channelId}` -> status
  initialStatuses: Record<string, string>;
}) {
  const [statuses, setStatuses] = useState(initialStatuses);
  const [pending, startTransition] = useTransition();

  function change(productId: string, channelId: string, status: string) {
    const key = `${productId}:${channelId}`;
    setStatuses((s) => ({ ...s, [key]: status })); // optimistic
    startTransition(async () => {
      const res = await setChannelStatus(productId, channelId, status);
      if (res?.error) alert(res.error);
    });
  }

  if (products.length === 0) {
    return <p className="text-sm text-slate-400">No products yet. Add products to publish them to channels.</p>;
  }

  return (
    <div className="card overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase text-muted">
            <th className="px-4 py-3 font-medium">Product</th>
            {channels.map((c) => (
              <th key={c.id} className="px-4 py-3 font-medium">
                {c.name}
                {c.supports_variants === false ? (
                  <span className="ml-1 font-normal text-[10px] lowercase text-slate-400">(no variants)</span>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
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
  );
}
