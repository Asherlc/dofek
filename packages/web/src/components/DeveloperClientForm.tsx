import {
  type DeveloperClientInput,
  DeveloperClientInputSchema,
} from "@dofek/auth/developer-clients";
import { type FormEvent, useRef, useState } from "react";
import type { z } from "zod";

interface DeveloperClientFormProps {
  error?: string | null;
  initialValue?: { name: string; redirectUris: string[] };
  isSubmitting?: boolean;
  onSubmit: (input: DeveloperClientInput) => Promise<void> | void;
  submitLabel?: string;
}

export function DeveloperClientForm({
  error,
  initialValue,
  isSubmitting = false,
  onSubmit,
  submitLabel = "Create integration",
}: DeveloperClientFormProps) {
  const [name, setName] = useState(initialValue?.name ?? "");
  const nextRedirectId = useRef(initialValue?.redirectUris.length ?? 1);
  const [redirects, setRedirects] = useState(() =>
    (initialValue?.redirectUris ?? [""]).map((value, id) => ({ id, value })),
  );
  const [validationIssues, setValidationIssues] = useState<z.core.$ZodIssue[]>([]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const parsed = DeveloperClientInputSchema.safeParse({
      name,
      redirectUris: redirects.map((redirect) => redirect.value),
      scopes: ["nutrition:write"],
    });
    if (!parsed.success) {
      setValidationIssues(parsed.error.issues);
      return;
    }
    setValidationIssues([]);
    void onSubmit(parsed.data);
  }

  function updateRedirect(index: number, value: string): void {
    setRedirects((current) =>
      current.map((redirect, currentIndex) =>
        currentIndex === index ? { ...redirect, value } : redirect,
      ),
    );
    setValidationIssues([]);
  }

  function removeRedirect(index: number): void {
    setRedirects((current) =>
      current.length === 1 ? current : current.filter((_, currentIndex) => currentIndex !== index),
    );
    setValidationIssues([]);
  }

  return (
    <form aria-label="Developer integration" onSubmit={submit} className="space-y-5">
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-foreground">Integration name</span>
        <input
          type="text"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setValidationIssues([]);
          }}
          aria-label="Integration name"
          className="w-full rounded-lg border border-border bg-surface-solid px-3 py-2 text-sm text-foreground"
        />
      </label>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-foreground">HTTPS redirect URIs</legend>
        {redirects.map((redirect, index) => (
          <div key={redirect.id} className="flex items-start gap-2">
            <label className="min-w-0 flex-1 space-y-1">
              <span className="sr-only">Redirect URI {index + 1}</span>
              <input
                type="url"
                value={redirect.value}
                onChange={(event) => updateRedirect(index, event.target.value)}
                aria-label={`Redirect URI ${index + 1}`}
                placeholder="https://integration.example/callback"
                className="w-full rounded-lg border border-border bg-surface-solid px-3 py-2 text-sm text-foreground"
              />
            </label>
            <button
              type="button"
              disabled={redirects.length === 1}
              onClick={() => removeRedirect(index)}
              aria-label={`Remove redirect URI ${index + 1}`}
              className="rounded border border-border px-3 py-2 text-sm text-muted disabled:opacity-40"
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => {
            const id = nextRedirectId.current;
            nextRedirectId.current += 1;
            setRedirects((current) => [...current, { id, value: "" }]);
          }}
          className="rounded border border-border px-3 py-2 text-sm text-foreground"
        >
          Add redirect URI
        </button>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-medium text-foreground">Scope</legend>
        <label className="mt-2 flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked disabled aria-label="nutrition:write" readOnly />
          <span className="font-mono">nutrition:write</span>
        </label>
      </fieldset>

      {validationIssues.length > 0 ? (
        <div role="alert" className="space-y-1 text-sm text-red-400">
          {validationIssues.map((issue) => (
            <p key={`${issue.code}-${issue.path.join(".")}-${issue.message}`}>{issue.message}</p>
          ))}
        </div>
      ) : null}
      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      <button
        type="submit"
        disabled={isSubmitting}
        className="rounded bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-50"
      >
        {isSubmitting ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}
