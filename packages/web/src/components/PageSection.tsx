import type { ReactNode } from "react";

export function PageSection({
  title,
  subtitle,
  card = true,
  children,
}: {
  title: string;
  subtitle?: string;
  card?: boolean;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="text-xs font-medium text-muted uppercase tracking-wider mb-3">{title}</h3>
      {subtitle && <p className="text-xs text-dim mb-3">{subtitle}</p>}
      {card ? <div className="card p-2 sm:p-4">{children}</div> : children}
    </section>
  );
}
