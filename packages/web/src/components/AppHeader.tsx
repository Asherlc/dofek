import { Link } from "@tanstack/react-router";

const navItems = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/training", label: "Training" },
  { to: "/insights", label: "Insights" },
  { to: "/providers", label: "Providers" },
  { to: "/settings", label: "Settings" },
] as const;

export function AppHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header className="border-b border-zinc-800 px-3 sm:px-6 py-3 sm:py-4 flex items-center justify-between gap-2 min-w-0">
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        <DofekLogo />
        <h1 className="text-lg sm:text-xl font-semibold tracking-tight shrink-0">Dofek</h1>
        <nav className="flex gap-1 ml-2 sm:ml-4 overflow-x-auto scrollbar-hide">
          {navItems.map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              className="px-3 py-2 text-xs rounded-md transition-colors text-zinc-500 hover:text-zinc-300 whitespace-nowrap"
              activeProps={{
                className:
                  "px-3 py-2 text-xs rounded-md transition-colors bg-zinc-700 text-zinc-100 whitespace-nowrap",
              }}
              activeOptions={{ exact: to === "/dashboard" }}
            >
              {label}
            </Link>
          ))}
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
