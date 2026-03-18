import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { formatRelativeTime, formatTime } from "../lib/dates.ts";
import { pollSyncJob } from "../lib/poll-sync-job.ts";
import { trpc } from "../lib/trpc.ts";
import { ProviderLogo } from "./ProviderLogo.tsx";

const oauthBroadcastMessage = z.object({
  type: z.literal("complete"),
  providerId: z.string().optional(),
});

const oauthPostMessage = z.object({
  type: z.literal("oauth-complete"),
  providerId: z.string().optional(),
});

type SyncStatus = "idle" | "syncing" | "done" | "error";

interface ProviderState {
  status: SyncStatus;
  message?: string;
}

export function DataSourcesPanel() {
  const providers = trpc.sync.providers.useQuery();
  const stats = trpc.sync.providerStats.useQuery();
  const logs = trpc.sync.logs.useQuery({ limit: 100 });
  const syncMutation = trpc.sync.triggerSync.useMutation();
  const trpcUtils = trpc.useUtils();

  const [providerStates, setProviderStates] = useState<Record<string, ProviderState>>({});
  const [syncAllMode, setSyncAllMode] = useState<"sync" | "full" | null>(null);

  // Custom auth modal state
  const [whoopAuthOpen, setWhoopAuthOpen] = useState(false);
  const [garminAuthOpen, setGarminAuthOpen] = useState(false);

  const updateState = useCallback(
    (id: string, state: ProviderState) => setProviderStates((prev) => ({ ...prev, [id]: state })),
    [],
  );

  const doPollSyncJob = useCallback(
    (jobId: string, providerIds: string[]) =>
      pollSyncJob({
        jobId,
        providerIds,
        fetchStatus: (id) => trpcUtils.sync.syncStatus.fetch({ jobId: id }, { staleTime: 0 }),
        updateState,
        onComplete: () => {
          trpcUtils.sync.providers.invalidate();
          trpcUtils.sync.providerStats.invalidate();
          trpcUtils.sync.logs.invalidate();
        },
      }),
    [trpcUtils, updateState],
  );

  const handleSync = useCallback(
    async (providerId: string, fullSync = false) => {
      updateState(providerId, { status: "syncing" });
      try {
        const { jobId } = await syncMutation.mutateAsync({
          providerId,
          sinceDays: fullSync ? undefined : 7,
        });
        await doPollSyncJob(jobId, [providerId]);
      } catch (err: unknown) {
        updateState(providerId, {
          status: "error",
          message: err instanceof Error ? err.message : "Sync failed",
        });
      }
    },
    [syncMutation, updateState, doPollSyncJob],
  );

  const handleSyncAll = useCallback(
    async (fullSync = false) => {
      setSyncAllMode(fullSync ? "full" : "sync");
      const enabled = (providers.data ?? []).filter(
        (p) => p.enabled && p.authorized && !p.importOnly,
      );
      const ids = enabled.map((p) => p.id);
      for (const p of enabled) {
        updateState(p.id, { status: "syncing" });
      }
      try {
        const { jobId } = await syncMutation.mutateAsync({
          sinceDays: fullSync ? undefined : 7,
        });
        await doPollSyncJob(jobId, ids);
      } catch (err: unknown) {
        for (const p of enabled) {
          updateState(p.id, {
            status: "error",
            message: err instanceof Error ? err.message : "Sync failed",
          });
        }
      } finally {
        setSyncAllMode(null);
      }
    },
    [providers.data, syncMutation, updateState, doPollSyncJob],
  );

  // Pre-compute stats and logs maps
  const statsByProvider = useMemo(
    () => new Map((stats.data ?? []).map((s) => [s.providerId, s])),
    [stats.data],
  );

  const syncRows: Array<{
    id: string;
    providerId: string;
    dataType: string;
    status: string;
    recordCount: number | null;
    errorMessage: string | null;
    durationMs: number | null;
    syncedAt: string;
  }> = logs.data ?? [];

  const logsByProvider = useMemo(() => {
    const map = new Map<string, typeof syncRows>();
    for (const row of syncRows) {
      let arr = map.get(row.providerId);
      if (!arr) {
        arr = [];
        map.set(row.providerId, arr);
      }
      arr.push(row);
    }
    return map;
  }, [syncRows]);

  const allProviders = providers.data ?? [];
  const enabledSyncable = allProviders.filter((p) => p.enabled && !p.importOnly);

  // Listen for OAuth completion from the popup via BroadcastChannel + postMessage.
  // Both channels may fire for the same event, so deduplicate with a timestamp.
  const lastOAuthHandledAt = useRef(0);
  useEffect(() => {
    const onOAuthComplete = (providerId?: string) => {
      const now = Date.now();
      if (now - lastOAuthHandledAt.current < 2000) return;
      lastOAuthHandledAt.current = now;

      trpcUtils.sync.providers.invalidate();
      // Auto-trigger a full sync for the newly connected provider
      if (providerId) {
        handleSync(providerId, true);
      }
    };
    // Primary: BroadcastChannel (same-origin, works even if window.opener is null)
    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel("oauth-complete");
      channel.onmessage = (event: MessageEvent) => {
        const parsed = oauthBroadcastMessage.safeParse(event.data);
        if (parsed.success) {
          onOAuthComplete(parsed.data.providerId);
        }
      };
    } catch {
      // BroadcastChannel not supported — rely on postMessage fallback
    }
    // Fallback: window.postMessage from the popup via window.opener
    const onMessage = (event: MessageEvent) => {
      // Validate origin to prevent accepting messages from malicious scripts
      if (event.origin !== window.location.origin) return;
      const parsed = oauthPostMessage.safeParse(event.data);
      if (parsed.success) {
        onOAuthComplete(parsed.data.providerId);
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      channel?.close();
      window.removeEventListener("message", onMessage);
    };
  }, [trpcUtils, handleSync]);

  const handleProviderClick = useCallback(
    (
      p: { id: string; needsOAuth: boolean; needsCustomAuth?: boolean; authorized: boolean },
      fullSync = false,
    ) => {
      if (p.needsCustomAuth && !p.authorized) {
        if (p.id === "garmin") {
          setGarminAuthOpen(true);
        } else {
          setWhoopAuthOpen(true);
        }
        return;
      }
      if (p.needsOAuth && !p.authorized) {
        window.open(`/auth/provider/${p.id}`, "_blank");
        return;
      }
      handleSync(p.id, fullSync);
    },
    [handleSync],
  );

  // File-import config for import-only providers + Apple Health (not a registered sync provider)
  const appleHealthConfig: FileImportZoneProps = {
    title: "Apple Health",
    description: ".zip or .xml from Health app export",
    accept: ".zip,.xml",
    uploadUrl: "/api/upload/apple-health?fullSync=true",
    statusUrl: "/api/upload/apple-health/status",
    chunked: true,
  };
  const fileImportConfigs: Record<string, FileImportZoneProps> = {
    "apple-health": appleHealthConfig,
    "strong-csv": {
      title: "Strong",
      description: ".csv export from Strong app",
      accept: ".csv",
      uploadUrl: "/api/upload/strong-csv?units=kg",
      statusUrl: "/api/upload/strong-csv/status",
    },
    "cronometer-csv": {
      title: "Cronometer",
      description: ".csv servings export from Cronometer",
      accept: ".csv",
      uploadUrl: "/api/upload/cronometer-csv",
      statusUrl: "/api/upload/cronometer-csv/status",
    },
  };

  // Build unified list: server providers + Apple Health (file-import-only, not registered on server)
  const unifiedProviders: Array<
    | { kind: "sync"; provider: (typeof allProviders)[number] }
    | { kind: "import"; id: string; config: FileImportZoneProps }
  > = [];

  // Add Apple Health first (always available, not in server provider list)
  unifiedProviders.push({
    kind: "import",
    id: "apple-health",
    config: appleHealthConfig,
  });

  for (const p of allProviders) {
    const importConfig = fileImportConfigs[p.id];
    if (importConfig) {
      unifiedProviders.push({ kind: "import", id: p.id, config: importConfig });
    } else {
      unifiedProviders.push({ kind: "sync", provider: p });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-300">Data Sources</h3>
        {enabledSyncable.length > 1 && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => handleSyncAll()}
              disabled={syncMutation.isPending}
              className={`text-xs px-3 py-1 rounded transition-colors ${
                syncAllMode === "sync"
                  ? "bg-emerald-600 text-white"
                  : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
              }`}
            >
              {syncAllMode === "sync" ? "Syncing..." : "Sync All"}
            </button>
            <button
              type="button"
              onClick={() => handleSyncAll(true)}
              disabled={syncMutation.isPending}
              className={`text-xs px-3 py-1 rounded transition-colors ${
                syncAllMode === "full"
                  ? "bg-emerald-600 text-white"
                  : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 disabled:opacity-50"
              }`}
            >
              {syncAllMode === "full" ? "Full Syncing..." : "Full Sync All"}
            </button>
          </div>
        )}
      </div>

      {providers.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {["skeleton-1", "skeleton-2", "skeleton-3"].map((id) => (
            <div key={id} className="h-24 rounded-lg bg-zinc-800/50 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {unifiedProviders.map((entry) => {
            if (entry.kind === "import") {
              const providerStats = statsByProvider.get(entry.id);
              const recentLogs = (logsByProvider.get(entry.id) ?? []).slice(0, 5);
              return (
                <FileImportZone
                  key={entry.id}
                  providerId={entry.id}
                  {...entry.config}
                  stats={providerStats}
                  recentLogs={recentLogs}
                />
              );
            }

            const p = entry.provider;
            const state = providerStates[p.id] ?? { status: "idle" };
            const needsAuth = (p.needsOAuth || p.needsCustomAuth) && !p.authorized;
            const providerStats = statsByProvider.get(p.id);
            const recentLogs = (logsByProvider.get(p.id) ?? []).slice(0, 5);

            return (
              <SyncProviderCard
                key={p.id}
                provider={p}
                state={state}
                needsAuth={needsAuth}
                stats={providerStats}
                recentLogs={recentLogs}
                onSync={() => handleProviderClick(p)}
                onFullSync={() => handleProviderClick(p, true)}
              />
            );
          })}
        </div>
      )}

      {/* WHOOP Auth Modal */}
      {whoopAuthOpen && (
        <WhoopAuthModal
          onClose={() => setWhoopAuthOpen(false)}
          onSuccess={() => {
            setWhoopAuthOpen(false);
            trpcUtils.sync.providers.invalidate();
          }}
        />
      )}

      {/* Garmin Auth Modal */}
      {garminAuthOpen && (
        <GarminAuthModal
          onClose={() => setGarminAuthOpen(false)}
          onSuccess={() => {
            setGarminAuthOpen(false);
            trpcUtils.sync.providers.invalidate();
          }}
        />
      )}
    </div>
  );
}

// ── Sync Provider Card (unified: controls + stats) ──

interface ProviderStats {
  activities: number;
  dailyMetrics: number;
  sleepSessions: number;
  bodyMeasurements: number;
  foodEntries: number;
  healthEvents: number;
  metricStream: number;
  nutritionDaily: number;
  labResults: number;
  journalEntries: number;
}

interface SyncLogEntry {
  status: string;
  syncedAt: string;
  recordCount: number | null;
  durationMs: number | null;
  errorMessage: string | null;
}

function SyncProviderCard({
  provider,
  state,
  needsAuth,
  stats,
  recentLogs,
  onSync,
  onFullSync,
}: {
  provider: { id: string; name: string; lastSyncedAt: string | null; authorized: boolean };
  state: ProviderState;
  needsAuth: boolean;
  stats: ProviderStats | undefined;
  recentLogs: SyncLogEntry[];
  onSync: () => void;
  onFullSync: () => void;
}) {
  const totalRecords = stats
    ? stats.activities +
      stats.dailyMetrics +
      stats.sleepSessions +
      stats.bodyMeasurements +
      stats.foodEntries +
      stats.healthEvents +
      stats.metricStream +
      stats.nutritionDaily +
      stats.labResults +
      stats.journalEntries
    : 0;

  const breakdown = stats
    ? [
        { label: "Activities", count: stats.activities },
        { label: "Metric Stream", count: stats.metricStream },
        { label: "Daily Metrics", count: stats.dailyMetrics },
        { label: "Sleep", count: stats.sleepSessions },
        { label: "Body", count: stats.bodyMeasurements },
        { label: "Food", count: stats.foodEntries },
        { label: "Nutrition", count: stats.nutritionDaily },
        { label: "Events", count: stats.healthEvents },
        { label: "Lab Results", count: stats.labResults },
        { label: "Journal", count: stats.journalEntries },
      ].filter((b) => b.count > 0)
    : [];

  return (
    <div className="flex flex-col rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 transition-colors">
      {/* Header with sync trigger */}
      <button
        type="button"
        onClick={onSync}
        disabled={state.status === "syncing"}
        className="flex items-center gap-2 hover:opacity-80 disabled:opacity-50"
        title={needsAuth ? "Click to connect" : "Sync last 7 days"}
      >
        <ProviderLogo provider={provider.id} size={18} />
        {needsAuth ? (
          <span className="inline-block w-2 h-2 rounded-full bg-blue-400" />
        ) : (
          <StatusDot status={state.status} />
        )}
        <span className="text-sm font-medium text-zinc-200">{provider.name}</span>
        {needsAuth && <span className="text-xs text-blue-400">Connect</span>}
        {state.status === "syncing" && <span className="text-xs text-zinc-500">...</span>}
      </button>

      {/* Status message */}
      {state.message && state.status !== "syncing" && (
        <span className="text-xs text-zinc-500 mt-1">{state.message}</span>
      )}
      {!state.message && provider.lastSyncedAt && (
        <span className="text-xs text-zinc-600 mt-1">
          Last sync: {formatRelativeTime(provider.lastSyncedAt)}
        </span>
      )}

      {/* Stats summary */}
      {totalRecords > 0 && (
        <div className="mt-2 pt-2 border-t border-zinc-800/50">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-bold text-zinc-100 tabular-nums">
              {totalRecords.toLocaleString()}
            </span>
            <span className="text-xs text-zinc-500">records</span>
          </div>
          {breakdown.length > 1 && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 mt-1">
              {breakdown.map((b) => (
                <div key={b.label} className="flex justify-between text-xs">
                  <span className="text-zinc-500">{b.label}</span>
                  <span className="text-zinc-400 tabular-nums">{b.count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Recent sync dots + full sync button */}
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-zinc-800/50">
        <div className="flex items-center gap-1">
          {recentLogs.map((l) => (
            <span
              key={`${l.syncedAt}-${l.status}-${l.recordCount}-${l.durationMs}`}
              className={`w-1.5 h-1.5 rounded-full ${
                l.status === "success" ? "bg-emerald-400" : "bg-red-400"
              }`}
              title={`${l.status} — ${formatTime(l.syncedAt)}`}
            />
          ))}
          {recentLogs.length === 0 && (
            <span className="text-xs text-zinc-600">No sync history</span>
          )}
        </div>
        {!needsAuth && state.status !== "syncing" && (
          <button
            type="button"
            onClick={onFullSync}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            Full sync
          </button>
        )}
      </div>
    </div>
  );
}

// ── Garmin Auth Modal ──

function GarminAuthModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  const signInMutation = trpc.garminAuth.signIn.useMutation();

  const handleSignIn = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError("");
      setLoading(true);
      try {
        await signInMutation.mutateAsync({ username, password });
        onSuccess();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Sign in failed");
      } finally {
        setLoading(false);
      }
    },
    [username, password, signInMutation, onSuccess],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-sm shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-zinc-200">Connect Garmin</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 text-lg leading-none p-1"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {error && (
          <div className="mb-3 text-xs text-red-400 bg-red-400/10 rounded px-3 py-2">{error}</div>
        )}

        <form onSubmit={handleSignIn} className="space-y-3">
          <div>
            <label htmlFor="garmin-email" className="block text-xs text-zinc-400 mb-1">
              Email
            </label>
            <input
              ref={emailRef}
              id="garmin-email"
              type="email"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-200 focus:outline-none focus:border-zinc-500"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label htmlFor="garmin-password" className="block text-xs text-zinc-400 mb-1">
              Password
            </label>
            <input
              id="garmin-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-200 focus:outline-none focus:border-zinc-500"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 text-sm font-medium rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors"
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── WHOOP Auth Modal ──

type WhoopStep = "credentials" | "verify" | "saving";

function WhoopAuthModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [step, setStep] = useState<WhoopStep>("credentials");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === "credentials") emailRef.current?.focus();
    if (step === "verify") codeRef.current?.focus();
  }, [step]);

  const signInMutation = trpc.whoopAuth.signIn.useMutation();
  const verifyMutation = trpc.whoopAuth.verifyCode.useMutation();
  const saveTokensMutation = trpc.whoopAuth.saveTokens.useMutation();

  const handleSignIn = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError("");
      setLoading(true);
      try {
        const result = await signInMutation.mutateAsync({ username, password });
        if (result.status === "verification_required") {
          setChallengeId(result.challengeId);
          setStep("verify");
        } else if (result.status === "success" && result.token) {
          setStep("saving");
          await saveTokensMutation.mutateAsync(result.token);
          onSuccess();
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Sign in failed");
      } finally {
        setLoading(false);
      }
    },
    [username, password, signInMutation, saveTokensMutation, onSuccess],
  );

  const handleVerify = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError("");
      setLoading(true);
      try {
        const result = await verifyMutation.mutateAsync({ challengeId, code });
        if (result.status === "success") {
          setStep("saving");
          await saveTokensMutation.mutateAsync(result.token);
          onSuccess();
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Verification failed");
      } finally {
        setLoading(false);
      }
    },
    [challengeId, code, verifyMutation, saveTokensMutation, onSuccess],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-sm shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-zinc-200">Connect WHOOP</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 text-lg leading-none p-1"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {error && (
          <div className="mb-3 text-xs text-red-400 bg-red-400/10 rounded px-3 py-2">{error}</div>
        )}

        {step === "credentials" && (
          <form onSubmit={handleSignIn} className="space-y-3">
            <div>
              <label htmlFor="whoop-email" className="block text-xs text-zinc-400 mb-1">
                Email
              </label>
              <input
                ref={emailRef}
                id="whoop-email"
                type="email"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-200 focus:outline-none focus:border-zinc-500"
                placeholder="you@example.com"
              />
            </div>
            <div>
              <label htmlFor="whoop-password" className="block text-xs text-zinc-400 mb-1">
                Password
              </label>
              <input
                id="whoop-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-200 focus:outline-none focus:border-zinc-500"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2 text-sm font-medium rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors"
            >
              {loading ? "Signing in..." : "Sign In"}
            </button>
          </form>
        )}

        {step === "verify" && (
          <form onSubmit={handleVerify} className="space-y-3">
            <p className="text-xs text-zinc-400">
              WHOOP sent a verification code to your phone. Enter it below.
            </p>
            <div>
              <label htmlFor="whoop-code" className="block text-xs text-zinc-400 mb-1">
                Verification Code
              </label>
              <input
                ref={codeRef}
                id="whoop-code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                inputMode="numeric"
                pattern="[0-9]*"
                className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-200 focus:outline-none focus:border-zinc-500 text-center tracking-widest text-lg"
                placeholder="000000"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2 text-sm font-medium rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors"
            >
              {loading ? "Verifying..." : "Verify"}
            </button>
          </form>
        )}

        {step === "saving" && (
          <div className="text-center py-4">
            <div className="text-sm text-zinc-300">Saving credentials...</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Helpers ──

function StatusDot({ status }: { status: SyncStatus }) {
  const colors = {
    idle: "bg-zinc-600",
    syncing: "bg-amber-400 animate-pulse",
    done: "bg-emerald-400",
    error: "bg-red-400",
  };
  const labels: Record<SyncStatus, string> = {
    idle: "Idle",
    syncing: "Syncing",
    done: "Synced",
    error: "Error",
  };
  return (
    <output
      className={`inline-block w-2 h-2 rounded-full ${colors[status]}`}
      aria-label={labels[status]}
    />
  );
}

// ── File Import Zone (reusable for Apple Health, Strong CSV, Cronometer CSV) ──

interface FileImportZoneProps {
  providerId?: string;
  title: string;
  description: string;
  accept: string;
  uploadUrl: string;
  statusUrl: string;
  chunked?: boolean;
  stats?: ProviderStats;
  recentLogs?: SyncLogEntry[];
}

function FileImportZone({
  providerId,
  title,
  description,
  accept,
  uploadUrl,
  statusUrl,
  chunked,
  stats,
  recentLogs = [],
}: FileImportZoneProps) {
  const [state, setState] = useState<{ status: SyncStatus; progress?: number; message?: string }>({
    status: "idle",
  });
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalRecords = stats
    ? stats.activities +
      stats.dailyMetrics +
      stats.sleepSessions +
      stats.bodyMeasurements +
      stats.foodEntries +
      stats.healthEvents +
      stats.metricStream +
      stats.nutritionDaily +
      stats.labResults +
      stats.journalEntries
    : 0;

  const breakdown = stats
    ? [
        { label: "Activities", count: stats.activities },
        { label: "Metric Stream", count: stats.metricStream },
        { label: "Daily Metrics", count: stats.dailyMetrics },
        { label: "Sleep", count: stats.sleepSessions },
        { label: "Body", count: stats.bodyMeasurements },
        { label: "Food", count: stats.foodEntries },
        { label: "Nutrition", count: stats.nutritionDaily },
        { label: "Events", count: stats.healthEvents },
        { label: "Lab Results", count: stats.labResults },
        { label: "Journal", count: stats.journalEntries },
      ].filter((b) => b.count > 0)
    : [];

  const pollStatus = useCallback(
    async (jobId: string) => {
      const poll = async (): Promise<void> => {
        try {
          const resp = await fetch(`${statusUrl}/${jobId}`);
          if (!resp.ok) throw new Error("Failed to get status");
          const data = await resp.json();

          if (data.status === "done") {
            setState({ status: "done", progress: 100, message: data.message });
            return;
          }
          if (data.status === "error") {
            setState({ status: "error", message: data.message ?? "Import failed" });
            return;
          }

          setState({
            status: "syncing",
            progress: data.progress ?? 0,
            message: data.message ?? "Processing...",
          });
          await new Promise((r) => setTimeout(r, 1000));
          return poll();
        } catch {
          setState({ status: "error", message: "Lost connection to server" });
        }
      };
      return poll();
    },
    [statusUrl],
  );

  const uploadFile = useCallback(
    async (file: File) => {
      setState({ status: "syncing", progress: 0, message: `Uploading ${file.name}...` });

      const MAX_RETRIES = 3;

      async function fetchWithRetry(
        url: string,
        init: RequestInit,
        attempt = 0,
      ): Promise<Response> {
        try {
          const resp = await fetch(url, init);
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({ error: resp.statusText }));
            throw new Error(err.error ?? `Upload failed (HTTP ${resp.status})`);
          }
          return resp;
        } catch (err) {
          const isNetworkError =
            err instanceof TypeError ||
            (err instanceof Error && err.message.includes("NetworkError"));
          if (isNetworkError && attempt < MAX_RETRIES) {
            const delay = 1000 * 2 ** attempt;
            await new Promise((r) => setTimeout(r, delay));
            return fetchWithRetry(url, init, attempt + 1);
          }
          throw err;
        }
      }

      try {
        let jobId: string | null = null;

        if (chunked) {
          const CHUNK_SIZE = 50 * 1024 * 1024;
          const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
          const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const fileExt = file.name.endsWith(".xml") ? ".xml" : ".zip";

          for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunk = file.slice(start, end);
            const uploadPct = Math.round(((i + 1) / totalChunks) * 50);
            setState({
              status: "syncing",
              progress: uploadPct,
              message:
                totalChunks > 1
                  ? `Uploading chunk ${i + 1}/${totalChunks}...`
                  : `Uploading ${file.name}...`,
            });

            const resp = await fetchWithRetry(uploadUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/octet-stream",
                "x-upload-id": uploadId,
                "x-chunk-index": String(i),
                "x-chunk-total": String(totalChunks),
                "x-file-ext": fileExt,
              },
              body: chunk,
            });
            const data = await resp.json();
            if (data.jobId) jobId = data.jobId;
          }
        } else {
          const resp = await fetchWithRetry(uploadUrl, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: file,
          });
          const data = await resp.json();
          jobId = data.jobId ?? null;
        }

        if (jobId) {
          setState({ status: "syncing", progress: 50, message: "Processing import..." });
          await pollStatus(jobId);
        }
      } catch (err: unknown) {
        const message =
          err instanceof TypeError
            ? "Network error — check your connection and try again"
            : err instanceof Error
              ? err.message
              : "Upload failed";
        setState({ status: "error", message });
      }
    },
    [uploadUrl, chunked, pollStatus],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) uploadFile(file);
    },
    [uploadFile],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) uploadFile(file);
    },
    [uploadFile],
  );

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        {providerId && <ProviderLogo provider={providerId} size={18} />}
        <StatusDot status={state.status} />
        <span className="text-sm font-medium text-zinc-200">{title}</span>
      </div>
      <button
        type="button"
        tabIndex={0}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        className={`rounded border-2 border-dashed p-3 text-center cursor-pointer transition-colors ${
          dragOver
            ? "border-blue-500 bg-blue-500/10"
            : "border-zinc-700 hover:border-zinc-600 bg-zinc-900/30"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={accept}
          onChange={handleFileSelect}
          className="hidden"
        />
        {state.status === "syncing" ? (
          <div>
            <div className="text-xs text-zinc-500">{state.message}</div>
            {state.progress != null && (
              <div className="mt-2 w-full h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                  style={{ width: `${state.progress}%` }}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="text-xs text-zinc-600">{description}</div>
        )}
      </button>
      {state.status !== "idle" && state.status !== "syncing" && (
        <div
          className={`mt-1.5 text-xs ${state.status === "error" ? "text-red-400" : "text-emerald-400"}`}
        >
          {state.message}
        </div>
      )}

      {/* Stats summary */}
      {totalRecords > 0 && (
        <div className="mt-2 pt-2 border-t border-zinc-800/50">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-bold text-zinc-100 tabular-nums">
              {totalRecords.toLocaleString()}
            </span>
            <span className="text-xs text-zinc-500">records</span>
          </div>
          {breakdown.length > 1 && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 mt-1">
              {breakdown.map((b) => (
                <div key={b.label} className="flex justify-between text-xs">
                  <span className="text-zinc-500">{b.label}</span>
                  <span className="text-zinc-400 tabular-nums">{b.count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Recent sync dots */}
      {recentLogs.length > 0 && (
        <div className="flex items-center gap-1 mt-2 pt-2 border-t border-zinc-800/50">
          {recentLogs.map((l) => (
            <span
              key={`${l.syncedAt}-${l.status}-${l.recordCount}-${l.durationMs}`}
              className={`w-1.5 h-1.5 rounded-full ${
                l.status === "success" ? "bg-emerald-400" : "bg-red-400"
              }`}
              title={`${l.status} — ${formatTime(l.syncedAt)}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
