import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useState } from "react";
import { useAuth } from "../lib/auth-context.tsx";

const navItems = [
  { to: "/dashboard", label: "Overview" },
  { to: "/training", label: "Training" },
  { to: "/activities", label: "Activities" },
  { to: "/sleep", label: "Sleep" },
  { to: "/nutrition", label: "Nutrition" },
  { to: "/body", label: "Body" },
  { to: "/correlation", label: "Correlation" },
  { to: "/tracking", label: "Tracking" },
  { to: "/health-report", label: "Reports" },
] as const;

const adminNavItems = [...navItems, { to: "/admin", label: "Admin" }] as const;

const desktopLinkClass =
  "block rounded-md px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-accent/10 hover:text-foreground";

const desktopActiveLinkClass =
  "block rounded-md px-3 py-2 text-sm font-semibold bg-accent/10 text-foreground";

const mobileLinkClass =
  "rounded-md px-3 py-2 text-xs font-medium text-muted transition-colors hover:bg-accent/10 hover:text-foreground whitespace-nowrap";

const mobileActiveLinkClass =
  "rounded-md px-3 py-2 text-xs font-semibold bg-accent/10 text-foreground whitespace-nowrap";

export function AppHeader({ children }: { children?: ReactNode }) {
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const mobileNavigationId = "app-mobile-navigation";

  const items = user?.isAdmin ? adminNavItems : navItems;

  return (
    <>
      <header className="lg:hidden border-b border-border bg-surface/85 backdrop-blur-xl">
        <div className="px-3 py-3 flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setMenuOpen((value) => !value)}
              className="p-1.5 text-muted hover:text-foreground transition-colors press"
              aria-label="Toggle navigation menu"
              aria-controls={mobileNavigationId}
              aria-expanded={menuOpen}
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
            <h1 className="text-lg font-semibold tracking-tight shrink-0">Dofek</h1>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {children}
            {user && (
              <button
                type="button"
                onClick={logout}
                className="text-xs font-medium text-subtle hover:text-foreground transition-colors cursor-pointer"
              >
                Sign out
              </button>
            )}
          </div>
        </div>
        {menuOpen && (
          <nav
            id={mobileNavigationId}
            className="px-3 pb-3 flex flex-wrap gap-1 nav-slide-enter"
            aria-label="Mobile"
          >
            {items.map(({ to, label }) => (
              <Link
                key={to}
                to={to}
                onClick={() => setMenuOpen(false)}
                className={mobileLinkClass}
                activeProps={{ className: mobileActiveLinkClass }}
                activeOptions={{ exact: to === "/dashboard" }}
              >
                {label}
              </Link>
            ))}
          </nav>
        )}
      </header>

      <aside
        aria-label="Primary navigation"
        className="hidden lg:flex lg:sticky lg:top-0 lg:h-screen lg:w-[13.5rem] lg:shrink-0 flex-col border-r border-border-strong bg-surface/70 px-4 py-5 backdrop-blur-xl"
      >
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <DofekLogo />
          <h1 className="text-lg font-semibold tracking-tight shrink-0">Dofek</h1>
        </div>

        <nav className="mt-8 flex flex-col gap-1" aria-label="Sections">
          {items.map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              className={desktopLinkClass}
              activeProps={{ className: desktopActiveLinkClass }}
              activeOptions={{ exact: to === "/dashboard" }}
            >
              {label}
            </Link>
          ))}
        </nav>

        <div className="mt-auto space-y-3">
          {children}
          {user && (
            <div className="rounded-md border border-border bg-surface-solid/70 p-3">
              <Link
                to="/settings"
                aria-label="Open settings"
                className="flex items-center justify-between gap-2 text-foreground hover:text-accent transition-colors"
              >
                <span className="block truncate text-xs font-semibold">{user.name}</span>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M11.49 2.17a1.5 1.5 0 00-2.98 0l-.1.77a7.8 7.8 0 00-1.34.55l-.62-.47a1.5 1.5 0 00-2.1 2.1l.47.62a7.8 7.8 0 00-.55 1.34l-.77.1a1.5 1.5 0 000 2.98l.77.1c.13.47.31.92.55 1.34l-.47.62a1.5 1.5 0 002.1 2.1l.62-.47c.42.24.87.42 1.34.55l.1.77a1.5 1.5 0 002.98 0l.1-.77c.47-.13.92-.31 1.34-.55l.62.47a1.5 1.5 0 002.1-2.1l-.47-.62c.24-.42.42-.87.55-1.34l.77-.1a1.5 1.5 0 000-2.98l-.77-.1a7.8 7.8 0 00-.55-1.34l.47-.62a1.5 1.5 0 00-2.1-2.1l-.62.47a7.8 7.8 0 00-1.34-.55l-.1-.77zM10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z"
                    clipRule="evenodd"
                  />
                </svg>
              </Link>
              <button
                type="button"
                onClick={logout}
                className="mt-1 text-xs text-subtle hover:text-foreground transition-colors cursor-pointer"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function DofekLogo() {
  return (
    <img
      src="/icon.svg"
      alt="Dofek logo"
      width={28}
      height={28}
      className="rounded-md logo-pulse"
    />
  );
}
