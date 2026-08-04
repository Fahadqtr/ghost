import { redirect } from "next/navigation";
import { V2_HOME } from "@/lib/v2/legacy-redirect";

export default function Home() {
  redirect(V2_HOME);
}
