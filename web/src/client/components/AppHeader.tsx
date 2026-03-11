export function AppHeader({
  activePage,
  children,
}: {
  activePage: "dashboard" | "insights";
  children?: React.ReactNode;
}) {
  return (
    <header className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <DofekLogo />
        <h1 className="text-xl font-semibold tracking-tight">Dofek</h1>
        <nav className="flex gap-1 ml-4">
          <a
            href="#dashboard"
            className={`px-3 py-1 text-xs rounded-md transition-colors ${
              activePage === "dashboard"
                ? "bg-zinc-700 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            Dashboard
          </a>
          <a
            href="#insights"
            className={`px-3 py-1 text-xs rounded-md transition-colors ${
              activePage === "insights"
                ? "bg-zinc-700 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            Insights
          </a>
        </nav>
      </div>
      {children}
    </header>
  );
}

function DofekLogo() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Dofek logo"
    >
      <title>Dofek</title>
      <circle cx="14" cy="14" r="13" stroke="#22c55e" strokeWidth="2" opacity="0.3" />
      <polyline
        points="3,14 8,14 10,8 13,20 16,6 19,18 21,14 25,14"
        stroke="#22c55e"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
