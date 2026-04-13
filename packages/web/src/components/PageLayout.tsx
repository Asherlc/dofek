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
    <div className="min-h-screen bg-page text-foreground overflow-x-hidden">
      <AppHeader>{headerChildren}</AppHeader>
      {tabs && (
        <nav className="border-b border-border px-3 sm:px-6">
          <div className="mx-auto max-w-7xl flex gap-1 overflow-x-auto scrollbar-hide">
            {tabs.map((tab) => (
              <Link
                key={tab.to}
                to={tab.to}
                activeOptions={{ exact: tab.exact }}
                className="px-3 py-2.5 text-xs transition-colors text-subtle hover:text-foreground whitespace-nowrap"
                activeProps={{
                  className:
                    "px-3 py-2.5 text-xs transition-colors text-foreground border-b-2 border-accent whitespace-nowrap",
                }}
              >
                {tab.label}
              </Link>
            ))}
          </div>
        </nav>
      )}
      <main className="mx-auto max-w-7xl px-3 sm:px-6 py-4 sm:py-6 space-y-6 sm:space-y-8">
        {title && (
          <div>
            <h2 className="text-sm font-medium text-muted uppercase tracking-wider">{title}</h2>
            {subtitle && <p className="text-xs text-dim mt-0.5">{subtitle}</p>}
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
