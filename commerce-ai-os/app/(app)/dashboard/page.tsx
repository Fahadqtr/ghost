import MilestonePlaceholder from "@/components/MilestonePlaceholder";

export default function DashboardPage() {
  return (
    <MilestonePlaceholder
      title="CEO Dashboard"
      milestone="Arrives in M3"
      description="KPI cards (Sales Today, Orders Today, Low Stock, Missing Images, Top Products, Alerts) reading the Supabase DB with graceful empty-states. Login protection lands in M3 too."
    />
  );
}
