import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "../lib/auth-context.tsx";
import { ModalDialog, ModalDialogTitle } from "./ModalDialog.tsx";

const navItems = [
  { to: "/dashboard", label: "Overview" },
  { to: "/data-quality", label: "Data quality" },
  { to: "/training", label: "Training" },
  { to: "/activities", label: "Activities" },
  { to: "/sleep", label: "Sleep" },
  { to: "/nutrition", label: "Nutrition" },
  { to: "/body", label: "Body" },
  { to: "/correlation", label: "Correlation" },
  { to: "/experiments", label: "Experiments" },
  { to: "/tracking", label: "Tracking" },
  { to: "/health-report", label: "Reports" },
  { to: "/more", label: "More" },
] as const;

const adminNavItems = [...navItems, { to: "/admin", label: "Admin" }] as const;

const desktopLinkClass =
  "block rounded-md px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-accent/10 hover:text-foreground";

const desktopActiveLinkClass =
  "block rounded-md px-3 py-2 text-sm font-semibold bg-accent/10 text-foreground";

const mobileLinkClass =
  "block rounded-md px-3 py-2.5 text-sm font-medium text-muted transition-colors hover:bg-accent/10 hover:text-foreground";

const mobileActiveLinkClass =
  "block rounded-md px-3 py-2.5 text-sm font-semibold bg-accent/10 text-foreground";

export function AppHeader({
  children,
  activeAlertCount = 0,
}: {
  children?: ReactNode;
  activeAlertCount?: number;
}) {
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const firstDesktopLinkRef = useRef<HTMLAnchorElement | null>(null);
  const firstMobileLinkRef = useRef<HTMLAnchorElement | null>(null);
  const mobileNavigationId = "app-mobile-navigation";

  const items = user?.isAdmin ? adminNavItems : navItems;

  useEffect(() => {
    const desktopMediaQuery = window.matchMedia("(min-width: 64rem)");
    const closeAtDesktopBreakpoint = () => {
      if (!desktopMediaQuery.matches) return;
      setMenuOpen(false);
      window.requestAnimationFrame(() => firstDesktopLinkRef.current?.focus());
    };

    desktopMediaQuery.addEventListener("change", closeAtDesktopBreakpoint);
    return () => {
      desktopMediaQuery.removeEventListener("change", closeAtDesktopBreakpoint);
    };
  }, []);

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
            <span className="text-lg font-semibold tracking-tight shrink-0">Dofek</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <AlertLink activeCount={activeAlertCount} compact />
            {children}
            {user && (
              <button
                type="button"
                onClick={logout}
                className="text-xs font-medium text-muted hover:text-foreground transition-colors cursor-pointer"
              >
                Sign out
              </button>
            )}
          </div>
        </div>
      </header>

      <ModalDialog
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        closeOnInteractOutside
        initialFocusRef={firstMobileLinkRef}
        overlayClassName="bg-black/45 backdrop-blur-sm lg:hidden"
        contentClassName="!left-0 !right-0 !top-0 !translate-x-0 !translate-y-0 w-full max-h-dvh overflow-y-auto overscroll-contain border-b border-border-strong bg-surface-solid p-3 shadow-2xl lg:hidden"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
          <ModalDialogTitle className="text-base font-semibold text-foreground">
            Navigation
          </ModalDialogTitle>
          <button
            type="button"
            onClick={() => setMenuOpen(false)}
            className="rounded-md border border-border px-3 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-accent/10"
            aria-label="Close navigation menu"
          >
            Close
          </button>
        </div>
        <nav id={mobileNavigationId} className="mt-3 flex flex-col gap-1" aria-label="Mobile">
          {items.map(({ to, label }, index) => (
            <Link
              key={to}
              ref={index === 0 ? firstMobileLinkRef : undefined}
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
      </ModalDialog>

      <aside
        aria-label="Primary navigation"
        className="hidden lg:flex lg:sticky lg:top-0 lg:h-screen lg:w-[13.5rem] lg:shrink-0 flex-col border-r border-border-strong bg-surface/70 px-4 py-5 backdrop-blur-xl"
      >
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <DofekLogo />
          <span className="text-lg font-semibold tracking-tight shrink-0">Dofek</span>
        </div>

        <nav className="mt-8 flex flex-col gap-1" aria-label="Sections">
          {items.map(({ to, label }, index) => (
            <Link
              key={to}
              ref={index === 0 ? firstDesktopLinkRef : undefined}
              to={to}
              className={desktopLinkClass}
              activeProps={{ className: desktopActiveLinkClass }}
              activeOptions={{ exact: to === "/dashboard" }}
            >
              {label}
            </Link>
          ))}
        </nav>

        <div className="mt-4">
          <AlertLink activeCount={activeAlertCount} />
        </div>

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
                className="mt-1 text-xs text-muted hover:text-foreground transition-colors cursor-pointer"
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

function AlertLink({ activeCount, compact = false }: { activeCount: number; compact?: boolean }) {
  const accessibleLabel = activeCount === 0 ? "Alerts" : `Alerts, ${activeCount} active`;
  return (
    <Link
      to="/alerts"
      aria-label={accessibleLabel}
      className={
        compact
          ? "relative flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-accent/10 hover:text-foreground"
          : "flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-accent/10 hover:text-foreground"
      }
      activeProps={compact ? undefined : { className: desktopActiveLinkClass }}
    >
      <span className="flex items-center gap-2">
        <BellIcon />
        {compact ? null : <span>Alerts</span>}
      </span>
      {activeCount > 0 ? (
        <span
          className={
            compact
              ? "absolute -right-1 -top-1 min-w-4 rounded-full bg-red-500 px-1 text-center text-[10px] font-bold leading-4 text-white"
              : "min-w-5 rounded-full bg-red-500 px-1.5 text-center text-[11px] font-bold leading-5 text-white"
          }
          aria-hidden="true"
        >
          {activeCount}
        </span>
      ) : null}
    </Link>
  );
}

function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M18 8a6 6 0 00-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
