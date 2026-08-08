// Malikas V2 Operations — Timeline Provider contract (Phase UI.7.4).
//
// A TimelineProvider is one SOURCE of timeline events (snapshot today; TickTick,
// Shopify, PureSoul, Talabat, Rafeeq, Launch Manager, Notifications, Excel, AI
// tomorrow). Each provider knows how to produce its own events from whatever it
// already holds; the TimelineEngine only aggregates + orders what providers
// return. Providers are PURE — they close over already-read data and never do
// I/O themselves — so this interface intentionally has no async and no client.

import type { TimelineEvent, TimelineSource } from "../../shared/models";

export interface TimelineProvider {
  /** which source this provider represents (also stamped on each event). */
  readonly source: TimelineSource;
  /** Return this source's events for the product. PURE: no I/O, no clock. */
  getEvents(): TimelineEvent[];
}
