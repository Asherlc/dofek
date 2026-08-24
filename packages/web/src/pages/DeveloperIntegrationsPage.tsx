import type {
  DeveloperClientInput,
  DeveloperClientSecret,
  DeveloperClientSummary,
} from "@dofek/auth/developer-clients";
import { formatDateTime } from "@dofek/format/format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { DeveloperClientForm } from "../components/DeveloperClientForm.tsx";
import { DeveloperClientSecretDialog } from "../components/DeveloperClientSecretDialog.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { PageSection } from "../components/PageSection.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { developerClientsApi } from "../lib/developer-clients.ts";

export interface DeveloperIntegrationsPageViewProps {
  clients: DeveloperClientSummary[] | undefined;
  createError: unknown;
  createdSecret: DeveloperClientSecret | null;
  isCreating: boolean;
  isLoading: boolean;
  listError: unknown;
  onCreate: (input: DeveloperClientInput) => void;
  onDismissSecret: () => void;
}

function errorMessage(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

export function DeveloperIntegrationsPageView({
  clients,
  createError,
  createdSecret,
  isCreating,
  isLoading,
  listError,
  onCreate,
  onDismissSecret,
}: DeveloperIntegrationsPageViewProps) {
  return (
    <PageLayout
      title="Developer integrations"
      subtitle="Register integrations that write nutrition data with explicit user consent."
    >
      <PageSection title="How authorization works">
        <div className="space-y-3 text-sm text-muted">
          <p>
            Your integration sends users through Dofek sign-in and consent. Keep the PKCE verifier
            in your integration and send the bearer client credential only in the Authorization
            header.
          </p>
          <a
            href="https://github.com/Asherlc/dofek/blob/main/docs/external-api.md"
            className="text-accent underline-offset-2 hover:underline"
          >
            External API contract
          </a>
          <pre className="overflow-x-auto rounded-lg border border-border bg-background p-3 text-xs text-foreground">
            <code>{`POST /api/external/link/start
Authorization: Bearer <client-id>.<client-secret>
Content-Type: application/json

{"redirectUri":"https://integration.example/callback","scopes":["nutrition:write"],"codeChallenge":"<S256-challenge>","codeChallengeMethod":"S256"}`}</code>
          </pre>
        </div>
      </PageSection>

      <PageSection title="Your integrations" subtitle="Open an integration to manage its access.">
        {isLoading && !clients ? (
          <QueryStatePanel
            variant="loading"
            contextLabel="Developer integrations"
            message="Loading developer integrations."
            height={120}
          />
        ) : listError && !clients ? (
          <QueryStatePanel error={listError} contextLabel="Developer integrations" height={120} />
        ) : clients?.length === 0 ? (
          <QueryStatePanel variant="empty" message="No developer integrations yet." height={120} />
        ) : (
          <div className="grid gap-3">
            {clients?.map((client) => (
              <a
                key={client.clientId}
                href={`/developer-integrations/${encodeURIComponent(client.clientId)}`}
                className="card block space-y-2 p-4 transition-colors hover:border-border-strong"
                aria-label={`${client.name} developer integration`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="font-medium text-foreground">{client.name}</h2>
                    <p className="font-mono text-xs text-dim">{client.clientId}</p>
                  </div>
                  <span
                    className={
                      client.status === "active"
                        ? "rounded bg-emerald-500/15 px-2 py-1 text-xs text-emerald-300"
                        : "rounded bg-slate-500/15 px-2 py-1 text-xs text-muted"
                    }
                  >
                    {client.status}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
                  <span>
                    Scope: <span className="font-mono">{client.scopes.join(", ")}</span>
                  </span>
                  <span>Created {formatDateTime(client.createdAt)}</span>
                  <span>Last rotated {formatDateTime(client.lastRotatedAt)}</span>
                </div>
              </a>
            ))}
          </div>
        )}
      </PageSection>

      <PageSection
        title="Create an integration"
        subtitle="Register every callback URI exactly as your integration will send it."
      >
        <DeveloperClientForm
          error={errorMessage(createError)}
          isSubmitting={isCreating}
          onSubmit={onCreate}
        />
      </PageSection>

      <DeveloperClientSecretDialog secret={createdSecret} onDismiss={onDismissSecret} />
    </PageLayout>
  );
}

export function DeveloperIntegrationsPage() {
  const queryClient = useQueryClient();
  const [createdSecret, setCreatedSecret] = useState<DeveloperClientSecret | null>(null);
  const clients = useQuery({
    queryKey: ["developer-clients"],
    queryFn: () => developerClientsApi.list(),
  });
  const createClient = useMutation({
    mutationFn: (input: DeveloperClientInput) => developerClientsApi.create(input),
    onSuccess: async (secret) => {
      setCreatedSecret(secret);
      await queryClient.invalidateQueries({ queryKey: ["developer-clients"] });
    },
  });

  return (
    <DeveloperIntegrationsPageView
      clients={clients.data}
      createError={createClient.error}
      createdSecret={createdSecret}
      isCreating={createClient.isPending}
      isLoading={clients.isLoading}
      listError={clients.error}
      onCreate={(input) => createClient.mutate(input)}
      onDismissSecret={() => setCreatedSecret(null)}
    />
  );
}
