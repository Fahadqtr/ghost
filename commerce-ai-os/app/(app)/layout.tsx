import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";

// Authenticated app shell: persistent sidebar + topbar.
// NOTE: Route protection (redirect to /login) is added in M3.
export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
