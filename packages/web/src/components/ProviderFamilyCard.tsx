import { type ReactNode, useState } from "react";

export interface ProviderFamilyMethod {
  id: string;
  label: string;
  content: ReactNode;
}

/** Presents multiple technical connection methods as one provider card. */
export function ProviderFamilyCard({
  familyLabel,
  methods,
}: {
  familyLabel: string;
  methods: ProviderFamilyMethod[];
}) {
  const [selectedMethodId, setSelectedMethodId] = useState(methods[0]?.id);
  const selectedMethod = methods.find((method) => method.id === selectedMethodId) ?? methods[0];

  if (!selectedMethod) return null;

  return (
    <section
      aria-label={`${familyLabel} connection methods`}
      className="rounded-lg border border-border bg-surface p-2"
    >
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <span className="text-sm font-medium text-foreground">{familyLabel}</span>
        <div role="tablist" aria-label={`${familyLabel} connection methods`} className="flex gap-1">
          {methods.map((method) => (
            <button
              key={method.id}
              type="button"
              role="tab"
              aria-selected={method.id === selectedMethod.id}
              onClick={() => setSelectedMethodId(method.id)}
              className="rounded px-2 py-1 text-xs text-muted hover:bg-surface-secondary hover:text-foreground aria-selected:bg-surface-secondary aria-selected:text-foreground"
            >
              {method.label}
            </button>
          ))}
        </div>
      </div>
      {selectedMethod.content}
    </section>
  );
}
