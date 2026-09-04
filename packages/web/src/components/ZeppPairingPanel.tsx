import { useEffect, useState } from "react";
import { trpc } from "../lib/trpc.ts";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

type ZeppConnection = { connectionType: "zepp-main" | "zepp-workout" };
type ZeppConnectionsState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "success"; connections: ZeppConnection[] };

interface ZeppPairingPanelBodyProps {
  connectionsState: ZeppConnectionsState;
  disconnectError: string | null;
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
  const connectionsQuery = trpc.companionToken.list.useQuery();
  useEffect(() => {
    setPairingCode(initialCode);
  }, [initialCode]);
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
  const connectionsState: ZeppConnectionsState = connectionsQuery.isLoading
    ? { status: "loading" }
    : connectionsQuery.error
      ? { status: "error", error: connectionsQuery.error }
      : connectionsQuery.data
        ? { status: "success", connections: connectionsQuery.data }
        : { status: "error", error: new Error("Zepp connections response was missing.") };

  return (
    <ZeppPairingPanelBody
      connectionsState={connectionsState}
      disconnectError={revokeMutation.error?.message ?? null}
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
  connectionsState,
  disconnectError,
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
        {connectionsState.status === "loading" ? (
          <QueryStatePanel variant="loading" message="Checking connections…" height={48} />
        ) : connectionsState.status === "error" ? (
          <QueryStatePanel
            error={connectionsState.error}
            contextLabel="Zepp connections"
            height={72}
          />
        ) : connectionsState.connections.length ? (
          connectionsState.connections.map(({ connectionType }) => {
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
          <QueryStatePanel variant="empty" message="No Zepp apps connected" height={48} />
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
