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
  initialMethodId,
}: {
  familyLabel: string;
  methods: ProviderFamilyMethod[];
  initialMethodId?: string;
}) {
  const [selectedMethodId, setSelectedMethodId] = useState(
    () => methods.find((method) => method.id === initialMethodId)?.id ?? methods[0]?.id,
  );
  const selectedMethod = methods.find((method) => method.id === selectedMethodId) ?? methods[0];

  if (!selectedMethod) return null;

  return (
    <section
      aria-label={`${familyLabel} connection methods`}
      className="rounded-lg border border-border bg-surface p-2"
    >
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <span className="text-sm font-medium text-foreground">{familyLabel}</span>
        <fieldset className="m-0 flex gap-1 border-0 p-0">
          <legend className="sr-only">{familyLabel} connection methods</legend>
          {methods.map((method) => (
            <button
              key={method.id}
              type="button"
              aria-pressed={method.id === selectedMethod.id}
              onClick={() => setSelectedMethodId(method.id)}
              className="rounded px-2 py-1 text-xs text-muted hover:bg-surface-secondary hover:text-foreground aria-pressed:bg-surface-secondary aria-pressed:text-foreground"
            >
              {method.label}
            </button>
          ))}
        </fieldset>
      </div>
      {selectedMethod.content}
    </section>
  );
}
