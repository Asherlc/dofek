import type {
  DeveloperClientDetail,
  DeveloperClientInput,
  DeveloperClientSecret,
} from "@dofek/auth/developer-clients";
import { formatDateTime } from "@dofek/format/format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { DeveloperClientForm } from "../components/DeveloperClientForm.tsx";
import { DeveloperClientSecretDialog } from "../components/DeveloperClientSecretDialog.tsx";
import {
  ModalDialog,
  ModalDialogDescription,
  ModalDialogTitle,
} from "../components/ModalDialog.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { PageSection } from "../components/PageSection.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { developerClientsApi } from "../lib/developer-clients.ts";

const listQueryKey = ["developer-clients"] as const;

function message(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

function ConfirmationDialog({
  actionLabel,
  cancelLabel,
  description,
  isPending,
  onCancel,
  onConfirm,
  open,
  title,
}: {
  actionLabel: string;
  cancelLabel: string;
  description: string;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
  title: string;
}) {
  return (
    <ModalDialog
      open={open}
      onClose={onCancel}
      closeOnEscape={!isPending}
      closeOnInteractOutside={!isPending}
      contentClassName="w-[calc(100%-2rem)] max-w-md rounded-xl border border-border bg-surface-solid p-6 shadow-2xl"
    >
      <ModalDialogTitle className="text-lg font-semibold text-foreground">{title}</ModalDialogTitle>
      <ModalDialogDescription className="mt-2 text-sm text-muted">
        {description}
      </ModalDialogDescription>
      <div className="mt-6 flex justify-end gap-2">
        <button
          type="button"
          disabled={isPending}
          onClick={onCancel}
          className="rounded px-3 py-2 text-sm text-muted disabled:opacity-40"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={onConfirm}
          className="rounded bg-red-500 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {isPending ? "Saving…" : actionLabel}
        </button>
      </div>
    </ModalDialog>
  );
}

export function DeveloperClientDetailPage() {
  const { clientId } = useParams({ from: "/developer-integrations/$clientId" });
  const queryClient = useQueryClient();
  const detailQueryKey = ["developer-clients", clientId] as const;
  const [confirmation, setConfirmation] = useState<"rotate" | "revoke" | null>(null);
  const [rotatedSecret, setRotatedSecret] = useState<DeveloperClientSecret | null>(null);
  const client = useQuery({
    queryKey: detailQueryKey,
    queryFn: () => developerClientsApi.get(clientId),
  });

  const invalidateClientQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: listQueryKey }),
      queryClient.invalidateQueries({ queryKey: detailQueryKey }),
    ]);
  };

  const updateClient = useMutation({
    mutationFn: (input: DeveloperClientInput) =>
      developerClientsApi.update(clientId, {
        name: input.name,
        redirectUris: input.redirectUris,
      }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(detailQueryKey, updated);
      await invalidateClientQueries();
    },
  });

  const rotateClient = useMutation({
    mutationFn: () => developerClientsApi.rotate(clientId),
    onSuccess: async (rotated) => {
      setRotatedSecret(rotated);
      queryClient.setQueryData(detailQueryKey, rotated.client);
      await invalidateClientQueries();
    },
  });

  const revokeClient = useMutation({
    mutationFn: () => developerClientsApi.revoke(clientId),
    onSuccess: async () => {
      queryClient.setQueryData<DeveloperClientDetail>(detailQueryKey, (current) =>
        current ? { ...current, status: "revoked" } : current,
      );
      await invalidateClientQueries();
    },
  });

  if (client.isLoading && !client.data) {
    return (
      <PageLayout title="Developer integration">
        <QueryStatePanel
          variant="loading"
          contextLabel="Developer integration"
          message="Loading developer integration."
        />
      </PageLayout>
    );
  }

  if (client.error && !client.data) {
    return (
      <PageLayout title="Developer integration">
        <QueryStatePanel error={client.error} contextLabel="Developer integration" />
      </PageLayout>
    );
  }

  if (!client.data) return null;

  const detail = client.data;
  const isRevoked = detail.status === "revoked";
  const mutationError = updateClient.error ?? rotateClient.error ?? revokeClient.error;

  return (
    <PageLayout title={detail.name} subtitle={detail.clientId}>
      <PageSection title="Integration details">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted">Status</dt>
            <dd className="text-foreground">{detail.status}</dd>
          </div>
          <div>
            <dt className="text-muted">Scope</dt>
            <dd className="font-mono text-foreground">{detail.scopes.join(", ")}</dd>
          </div>
          <div>
            <dt className="text-muted">Created</dt>
            <dd className="text-foreground">{formatDateTime(detail.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-muted">Last rotated</dt>
            <dd className="text-foreground">{formatDateTime(detail.lastRotatedAt)}</dd>
          </div>
        </dl>
        <div className="mt-4 space-y-2">
          <h2 className="text-sm font-medium text-foreground">Registered redirect URIs</h2>
          <ul className="space-y-1">
            {detail.redirectUris.map((redirectUri) => (
              <li key={redirectUri} className="break-all font-mono text-xs text-muted">
                {redirectUri}
              </li>
            ))}
          </ul>
        </div>
      </PageSection>

      <PageSection
        title="Edit integration"
        subtitle={isRevoked ? "Revoked integrations cannot be changed." : undefined}
      >
        <DeveloperClientForm
          key={JSON.stringify([detail.name, detail.redirectUris])}
          disabled={isRevoked}
          error={message(updateClient.error)}
          initialValue={{ name: detail.name, redirectUris: detail.redirectUris }}
          isSubmitting={updateClient.isPending}
          onSubmit={(input) => updateClient.mutate(input)}
          submitLabel="Save integration"
        />
      </PageSection>

      <PageSection title="Credential and access">
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            disabled={isRevoked || rotateClient.isPending}
            onClick={() => setConfirmation("rotate")}
            className="rounded border border-border px-3 py-2 text-sm text-foreground disabled:opacity-40"
          >
            Rotate client secret
          </button>
          <button
            type="button"
            disabled={isRevoked || revokeClient.isPending}
            onClick={() => setConfirmation("revoke")}
            className="rounded border border-red-400/50 px-3 py-2 text-sm text-red-300 disabled:opacity-40"
          >
            Revoke developer integration
          </button>
        </div>
        {mutationError && mutationError !== updateClient.error ? (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {message(mutationError)}
          </p>
        ) : null}
      </PageSection>

      <ConfirmationDialog
        open={confirmation === "rotate"}
        title="Rotate client secret?"
        description="The existing secret stops working immediately. Save the replacement before closing its one-time dialog."
        actionLabel="Confirm rotation"
        cancelLabel="Cancel rotation"
        isPending={rotateClient.isPending}
        onCancel={() => {
          if (!rotateClient.isPending) setConfirmation(null);
        }}
        onConfirm={() => {
          setConfirmation(null);
          rotateClient.mutate();
        }}
      />
      <ConfirmationDialog
        open={confirmation === "revoke"}
        title="Revoke developer integration?"
        description="The client and all active grants stop working immediately. This cannot be undone."
        actionLabel="Confirm revocation"
        cancelLabel="Cancel revocation"
        isPending={revokeClient.isPending}
        onCancel={() => {
          if (!revokeClient.isPending) setConfirmation(null);
        }}
        onConfirm={() => {
          setConfirmation(null);
          revokeClient.mutate();
        }}
      />
      <DeveloperClientSecretDialog
        secret={rotatedSecret}
        onDismiss={() => setRotatedSecret(null)}
      />
    </PageLayout>
  );
}
