// Owner-only screen: upload a ready-made Rafeeq archive and get its link.

import { requireOwner } from "@/lib/malak/authz";
import RafeeqPackageUpload from "./RafeeqPackageUpload";

export const dynamic = "force-dynamic";

export default async function Page() {
  const owner = await requireOwner();
  if (!owner.ok) {
    return <main dir="rtl" style={{ padding: 24 }}><p>{owner.error}</p></main>;
  }
  return (
    <main dir="rtl" style={{ padding: 24 }}>
      <RafeeqPackageUpload />
    </main>
  );
}
