import type { ReactNode } from "react";
import { AppHeader } from "./AppHeader.tsx";

export function PageLayout({
  headerChildren,
  nav,
  title,
  subtitle,
  children,
}: {
  headerChildren?: ReactNode;
  nav?: ReactNode;
  title?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-page text-foreground overflow-x-hidden">
      <AppHeader>{headerChildren}</AppHeader>
      {nav}
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
