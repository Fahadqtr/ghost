// Malikas V2 top bar (Phase UI.1). Brand + section title + signed-in email, with
// a menu button that opens the sidebar drawer on mobile. No timers/polling.

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </svg>
  );
}

export default function V2Topbar({ userEmail, onMenu }: { userEmail?: string | null; onMenu: () => void }) {
  return (
    <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-[#efe3d6] bg-[#fffaf4]/90 px-4 py-3 backdrop-blur">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onMenu}
          aria-label="فتح القائمة"
          className="rounded-lg border border-[#e7d9c9] bg-white p-1.5 text-ink md:hidden"
        >
          <MenuIcon />
        </button>
        <div className="leading-tight">
          <div className="font-serif text-lg font-semibold tracking-wide text-brand">Malikas</div>
          <div className="text-xs text-muted">إدارة الكتالوج</div>
        </div>
      </div>
      {userEmail ? (
        <div className="max-w-[45%] truncate text-xs text-muted" dir="ltr" title={userEmail}>
          {userEmail}
        </div>
      ) : null}
    </header>
  );
}
