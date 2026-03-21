import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useAuth } from "../lib/auth-context.tsx";

const navItems = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/training", label: "Training" },
  { to: "/sleep", label: "Sleep" },
  { to: "/nutrition", label: "Nutrition" },
  { to: "/body", label: "Body" },
  { to: "/correlation", label: "Correlation" },
  { to: "/tracking", label: "Tracking" },
  { to: "/settings", label: "Settings" },
] as const;

export function AppHeader({ children }: { children?: React.ReactNode }) {
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="border-b border-zinc-800">
      <div className="px-3 sm:px-6 py-3 sm:py-4 flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="lg:hidden p-1 text-zinc-400 hover:text-zinc-200 transition-colors"
            aria-label="Toggle navigation menu"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="currentColor"
              role="img"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M3 5h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2z"
                clipRule="evenodd"
              />
            </svg>
          </button>
          <DofekLogo />
          <h1 className="text-lg sm:text-xl font-semibold tracking-tight shrink-0">Dofek</h1>
          <nav className="hidden lg:flex gap-1 ml-4 overflow-x-auto scrollbar-hide">
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
        <div className="flex items-center gap-3 shrink-0">
          {children}
          {user && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-400 hidden sm:inline">{user.name}</span>
              <button
                type="button"
                onClick={logout}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
      {menuOpen && (
        <nav className="lg:hidden px-3 pb-3 flex flex-wrap gap-1">
          {navItems.map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              onClick={() => setMenuOpen(false)}
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
      )}
    </header>
  );
}

function DofekLogo() {
  return <img src="/icon.svg" alt="Dofek logo" width={28} height={28} className="rounded-md" />;
}
