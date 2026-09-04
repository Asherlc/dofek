import { useEffect, useState } from "react";
import { trpc } from "../lib/trpc.ts";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

type ZeppConnection = { connectionType: "zepp-main" | "zepp-workout" };

interface ZeppPairingPanelBodyProps {
  connections?: ZeppConnection[];
  connectionsError: string | null;
  disconnectError: string | null;
  isConnectionsLoading: boolean;
  isPairingError: boolean;
  isPairingPending: boolean;
  pairingCode: string;
  pairingMessage: string | null;
  onDisconnect: (connectionType: ZeppConnection["connectionType"]) => void;
  onPairingCodeChange: (code: string) => void;
  onSubmit: () => void;
}

export function ZeppPairingPanel({ initialCode = "" }: { initialCode?: string }) {
  const [pairingCode, setPairingCode] = useState(initialCode);
  useEffect(() => setPairingCode(initialCode), [initialCode]);
  const connectionsQuery = trpc.companionToken.list.useQuery();
  const revokeMutation = trpc.companionToken.revoke.useMutation({
    onSuccess: async () => {
      await connectionsQuery.refetch();
    },
  });
  const pairingMutation = trpc.companionPairing.claim.useMutation({
    onSuccess: async () => {
      setPairingCode("");
      await connectionsQuery.refetch();
    },
  });
  const connectionLabel =
    pairingMutation.data?.connectionType === "zepp-workout" ? "Workout extension" : "Zepp app";

  return (
    <ZeppPairingPanelBody
      connections={
        connectionsQuery.isLoading || connectionsQuery.error ? undefined : connectionsQuery.data
      }
      connectionsError={connectionsQuery.error?.message ?? null}
      disconnectError={revokeMutation.error?.message ?? null}
      isConnectionsLoading={connectionsQuery.isLoading}
      isPairingError={pairingMutation.isError}
      isPairingPending={pairingMutation.isPending}
      pairingCode={pairingCode}
      pairingMessage={
        pairingMutation.isSuccess
          ? `${connectionLabel} connected. Return to Zepp to sync.`
          : (pairingMutation.error?.message ?? null)
      }
      onDisconnect={(connectionType) => revokeMutation.mutate({ connectionType })}
      onPairingCodeChange={setPairingCode}
      onSubmit={() => pairingMutation.mutate({ code: pairingCode })}
    />
  );
}

export function ZeppPairingPanelBody({
  connections,
  connectionsError,
  disconnectError,
  isConnectionsLoading,
  isPairingError,
  isPairingPending,
  pairingCode,
  pairingMessage,
  onDisconnect,
  onPairingCodeChange,
  onSubmit,
}: ZeppPairingPanelBodyProps) {
  const normalizedPairingCode = pairingCode.trim();

  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded border border-border bg-surface-solid p-3">
        <p className="text-xs font-medium text-foreground">Current connections</p>
        {isConnectionsLoading ? (
          <QueryStatePanel variant="loading" message="Checking connections…" height={72} />
        ) : connectionsError ? (
          <QueryStatePanel error={connectionsError} height={72} />
        ) : connections?.length ? (
          connections.map(({ connectionType }) => {
            const label = connectionType === "zepp-main" ? "Zepp app" : "Workout extension";
            return (
              <div key={connectionType} className="flex items-center justify-between gap-3">
                <span className="text-xs text-accent">{label}: Connected</span>
                <button
                  type="button"
                  aria-label={`Disconnect ${label}`}
                  className="text-xs text-red-400 hover:text-red-300"
                  onClick={() => onDisconnect(connectionType)}
                >
                  Disconnect
                </button>
              </div>
            );
          })
        ) : (
          <p className="text-xs text-subtle">No Zepp apps connected</p>
        )}
        {disconnectError ? <p className="text-xs text-red-400">{disconnectError}</p> : null}
      </div>
      <label className="block space-y-1">
        <span className="text-xs text-subtle">Short code</span>
        <input
          type="text"
          aria-label="Short code"
          value={pairingCode}
          onChange={(event) => onPairingCodeChange(event.target.value)}
          className="w-full rounded border border-border bg-surface-solid px-3 py-2 text-sm text-foreground"
          placeholder="ABC234"
          autoCapitalize="characters"
        />
      </label>
      <button
        type="button"
        onClick={onSubmit}
        disabled={isPairingPending || !normalizedPairingCode}
        className="rounded bg-accent px-3 py-2 text-sm text-on-accent transition-colors hover:bg-accent/90 disabled:opacity-50"
      >
        {isPairingPending ? "Connecting..." : "Connect Zepp App"}
      </button>
      {pairingMessage ? (
        <p className={isPairingError ? "text-xs text-red-400" : "text-xs text-accent"}>
          {pairingMessage}
        </p>
      ) : null}
    </div>
  );
}
