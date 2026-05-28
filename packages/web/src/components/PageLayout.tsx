import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppHeader } from "./AppHeader.tsx";

interface Tab {
  to: string;
  label: string;
  exact: boolean;
}

export function PageLayout({
  headerChildren,
  tabs,
  title,
  subtitle,
  children,
}: {
  headerChildren?: ReactNode;
  tabs?: readonly Tab[];
  title?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-page text-foreground overflow-x-hidden lg:flex">
      <AppHeader />
      <div className="lg:min-w-0 lg:flex-1">
        {tabs && (
          <nav
            className="border-b border-border px-3 sm:px-6 bg-surface/45 backdrop-blur-xl"
            aria-label="Section tabs"
          >
            <div className="mx-auto max-w-6xl flex gap-1 overflow-x-auto scrollbar-hide">
              {tabs.map((tab) => (
                <Link
                  key={tab.to}
                  to={tab.to}
                  activeOptions={{ exact: tab.exact }}
                  className="px-3 py-2.5 text-xs font-medium transition-colors text-subtle hover:text-foreground whitespace-nowrap"
                  activeProps={{
                    className:
                      "px-3 py-2.5 text-xs font-semibold transition-colors text-foreground border-b-2 border-accent whitespace-nowrap",
                  }}
                >
                  {tab.label}
                </Link>
              ))}
            </div>
          </nav>
        )}
        <main className="mx-auto max-w-6xl px-3 py-4 sm:px-6 sm:py-6 lg:py-8 space-y-6 sm:space-y-7">
          {(title || headerChildren) && (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              {title ? (
                <div>
                  <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
                  {subtitle && <p className="text-sm text-muted mt-1">{subtitle}</p>}
                </div>
              ) : (
                <div />
              )}
              {headerChildren && (
                <div className="flex shrink-0 justify-start">{headerChildren}</div>
              )}
            </div>
          )}
          <div className="space-y-6 sm:space-y-7">{children}</div>
        </main>
      </div>
    </div>
  );
}
