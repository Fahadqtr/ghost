// CH.4 — Channel Adapter registry (PURE).
//
// Holds the set of registered adapters and dispatches by channel or by store.
// Store-aware: a single channel may register several stores, and stores are
// addressable by their globally-unique storeKey. No DB, no network, no @/ import.

import { type ChannelAdapter, type ChannelKey, type StoreRef } from "./types.ts";

export interface ResolvedStore {
  adapter: ChannelAdapter;
  store: StoreRef;
}

export class AdapterRegistry {
  private readonly byChannel = new Map<ChannelKey, ChannelAdapter>();

  /** Register (or replace) the adapter for a channel. Returns this for chaining. */
  register(adapter: ChannelAdapter): this {
    this.byChannel.set(adapter.channel, adapter);
    return this;
  }

  has(channel: ChannelKey): boolean {
    return this.byChannel.has(channel);
  }

  get(channel: ChannelKey): ChannelAdapter | null {
    return this.byChannel.get(channel) ?? null;
  }

  /** All registered channels, in registration order. */
  channels(): ChannelKey[] {
    return [...this.byChannel.keys()];
  }

  /** Every store across every registered adapter (channel → store fan-out). */
  stores(): ResolvedStore[] {
    const out: ResolvedStore[] = [];
    for (const adapter of this.byChannel.values()) {
      for (const store of adapter.stores()) out.push({ adapter, store });
    }
    return out;
  }

  /** Stores belonging to one channel (>= 1; a channel can own several). */
  storesFor(channel: ChannelKey): StoreRef[] {
    const adapter = this.byChannel.get(channel);
    return adapter ? [...adapter.stores()] : [];
  }

  /** Resolve a store by its globally-unique storeKey, with its owning adapter. */
  storeByKey(storeKey: string): ResolvedStore | null {
    for (const adapter of this.byChannel.values()) {
      const store = adapter.stores().find((s) => s.storeKey === storeKey);
      if (store) return { adapter, store };
    }
    return null;
  }
}

/** Convenience constructor: build a registry from a list of adapters. */
export function createRegistry(adapters: ChannelAdapter[] = []): AdapterRegistry {
  const reg = new AdapterRegistry();
  for (const a of adapters) reg.register(a);
  return reg;
}
