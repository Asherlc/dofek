import { formatDateTime } from "@dofek/format/format";
import type { AppRouterOutputs } from "dofek-server/router";
import { useState } from "react";
import { trpc } from "../lib/trpc.ts";
import { ModalDialog, ModalDialogDescription, ModalDialogTitle } from "./ModalDialog.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

export type DeveloperClientSupportItem = AppRouterOutputs["admin"]["externalClients"][number];

export interface DeveloperClientsAdminPanelViewProps {
  clients: DeveloperClientSupportItem[] | undefined;
  error: unknown;
  isLoading: boolean;
  isRevoking: boolean;
  mutationError: unknown;
  onCancelRevoke: () => void;
  onConfirmRevoke: () => void;
  onRequestRevoke: (client: DeveloperClientSupportItem) => void;
  selectedClient: DeveloperClientSupportItem | null;
}

function ownerLabel(client: DeveloperClientSupportItem): string {
  return client.ownerName ?? client.ownerEmail ?? "Owner unavailable";
}

export function DeveloperClientsAdminPanelView({
  clients,
  error,
  isLoading,
  isRevoking,
  mutationError,
  onCancelRevoke,
  onConfirmRevoke,
  onRequestRevoke,
  selectedClient,
}: DeveloperClientsAdminPanelViewProps) {
  if (isLoading && !clients) {
    return (
      <QueryStatePanel
        variant="loading"
        contextLabel="Developer integrations"
        message="Loading developer integrations."
        height={120}
      />
    );
  }
  if (error && !clients) {
    return <QueryStatePanel error={error} contextLabel="Developer integrations" height={120} />;
  }
  if (clients?.length === 0) {
    return (
      <QueryStatePanel
        variant="empty"
        message="No developer integrations are registered."
        height={120}
      />
    );
  }

  return (
    <section className="space-y-4" aria-label="Developer clients support inventory">
      {error ? (
        <QueryStatePanel error={error} contextLabel="Developer integrations" height={96} />
      ) : null}
      {mutationError ? (
        <QueryStatePanel
          error={mutationError}
          contextLabel="Developer integration revocation"
          height={96}
        />
      ) : null}

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[760px] text-xs">
          <thead>
            <tr className="border-b border-border text-left text-muted">
              <th className="px-3 py-2 font-medium">Integration</th>
              <th className="px-3 py-2 font-medium">Owner</th>
              <th className="px-3 py-2 font-medium">Scope</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2 font-medium">Last rotated</th>
              <th className="px-3 py-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {clients?.map((client) => (
              <tr key={client.clientId} className="border-b border-border/50 text-foreground">
                <td className="px-3 py-3">
                  <div className="font-medium">{client.name}</div>
                  <div className="font-mono text-dim">{client.clientId}</div>
                </td>
                <td className="px-3 py-3">
                  <div>{ownerLabel(client)}</div>
                  {client.ownerName && client.ownerEmail ? (
                    <div className="text-dim">{client.ownerEmail}</div>
                  ) : null}
                </td>
                <td className="px-3 py-3 font-mono">{client.scopes.join(", ")}</td>
                <td className="px-3 py-3">
                  <span
                    className={
                      client.status === "active"
                        ? "rounded bg-emerald-500/15 px-2 py-1 text-emerald-300"
                        : "rounded bg-slate-500/15 px-2 py-1 text-muted"
                    }
                  >
                    {client.status}
                  </span>
                </td>
                <td className="px-3 py-3">{formatDateTime(client.createdAt)}</td>
                <td className="px-3 py-3">{formatDateTime(client.lastRotatedAt)}</td>
                <td className="px-3 py-3">
                  <button
                    type="button"
                    disabled={client.status === "revoked" || isRevoking}
                    onClick={() => onRequestRevoke(client)}
                    className="rounded border border-red-400/40 px-2 py-1 text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={`Revoke ${client.name}`}
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ModalDialog
        open={selectedClient !== null}
        onClose={onCancelRevoke}
        closeOnEscape={!isRevoking}
        closeOnInteractOutside={!isRevoking}
        contentClassName="w-[calc(100%-2rem)] max-w-md rounded-xl border border-border bg-surface-solid p-6 shadow-2xl"
      >
        <ModalDialogTitle className="text-lg font-semibold text-foreground">
          Revoke developer integration?
        </ModalDialogTitle>
        <ModalDialogDescription className="mt-2 text-sm text-muted">
          {selectedClient
            ? `This immediately revokes ${selectedClient.name} and all of its active grants.`
            : "This immediately revokes the integration and all of its active grants."}
        </ModalDialogDescription>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            disabled={isRevoking}
            onClick={onCancelRevoke}
            className="rounded px-3 py-2 text-sm text-muted disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isRevoking}
            onClick={onConfirmRevoke}
            className="rounded bg-red-500 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {isRevoking ? "Revoking…" : "Confirm revoke"}
          </button>
        </div>
      </ModalDialog>
    </section>
  );
}

export function DeveloperClientsAdminPanel() {
  const [selectedClient, setSelectedClient] = useState<DeveloperClientSupportItem | null>(null);
  const clients = trpc.admin.externalClients.useQuery();
  const utilities = trpc.useUtils();
  const revokeClient = trpc.admin.revokeExternalClient.useMutation({
    onSuccess: async () => {
      await utilities.admin.externalClients.invalidate();
      setSelectedClient(null);
    },
  });

  return (
    <DeveloperClientsAdminPanelView
      clients={clients.data}
      error={clients.error}
      isLoading={clients.isLoading}
      isRevoking={revokeClient.isPending}
      mutationError={revokeClient.error}
      onCancelRevoke={() => {
        if (!revokeClient.isPending) setSelectedClient(null);
      }}
      onConfirmRevoke={() => {
        if (selectedClient) revokeClient.mutate({ clientId: selectedClient.clientId });
      }}
      onRequestRevoke={setSelectedClient}
      selectedClient={selectedClient}
    />
  );
}
