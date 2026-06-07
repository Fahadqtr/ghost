// Force /malak to render dynamically (per request) instead of being a cached
// static page. Static /malak HTML was getting stuck in browser/edge caches, so
// new deploys (confirm card, markers, etc.) wouldn't show. Dynamic + the
// no-store header in next.config means every load reflects the latest build.
import MalakClient from "./MalakClient";

export const dynamic = "force-dynamic";

export default function Page() {
  return <MalakClient />;
}
