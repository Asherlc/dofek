import * as Sentry from "@sentry/react-native";
import * as Updates from "expo-updates";
import { logger } from "./telemetry";

type StartupPhase = "javascript" | "authentication" | "splash-hide" | "service-bootstrap";

type StartupOutcome =
  | "authenticated"
  | "deferred"
  | "error"
  | "ready"
  | "skipped"
  | "unauthenticated";

type StartupSpan = ReturnType<typeof Sentry.startInactiveSpan>;

interface PhaseRecord {
  span: StartupSpan;
  startedAtMs: number;
  finished: boolean;
}

const PHASE_DETAILS: Record<StartupPhase, { name: string; op: string }> = {
  javascript: {
    name: "JavaScript bootstrap",
    op: "app.start.javascript",
  },
  authentication: {
    name: "Authentication bootstrap",
    op: "app.start.authentication",
  },
  "splash-hide": {
    name: "Splash dismissal",
    op: "app.start.splash_hide",
  },
  "service-bootstrap": {
    name: "Deferred service bootstrap",
    op: "app.start.service_bootstrap",
  },
};

let startupSpan: StartupSpan | undefined;
let startupStartedAtMs: number | undefined;
let interactiveAtMs: number | undefined;
let appLoadedRecorded = false;
let lifecycleFinished = false;
let lifecycleOutcome: "error" | "ready" = "ready";
const phases = new Map<StartupPhase, PhaseRecord>();

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function expoLaunchDurationMs(): number {
  return typeof Updates.launchDuration === "number" && Updates.launchDuration >= 0
    ? Updates.launchDuration
    : 0;
}

function startPhaseAt(phase: StartupPhase, startedAtMs: number): PhaseRecord {
  const existing = phases.get(phase);
  if (existing && (!existing.finished || phase !== "authentication")) {
    return existing;
  }

  const parentSpan = startStartupTelemetry();
  const details = PHASE_DETAILS[phase];
  const record: PhaseRecord = {
    span: Sentry.startInactiveSpan({
      name: details.name,
      op: details.op,
      parentSpan,
      startTime: new Date(startedAtMs),
    }),
    startedAtMs,
    finished: false,
  };
  phases.set(phase, record);
  return record;
}

function finishLifecycleIfReady(): void {
  if (
    lifecycleFinished ||
    interactiveAtMs === undefined ||
    !phases.get("service-bootstrap")?.finished ||
    !startupSpan ||
    startupStartedAtMs === undefined
  ) {
    return;
  }

  const finishedAtMs = Date.now();
  startupSpan.setAttributes({
    "app.start.interactive_duration_ms": interactiveAtMs - startupStartedAtMs,
    "app.start.lifecycle_duration_ms": finishedAtMs - startupStartedAtMs,
    "app.start.lifecycle_outcome": lifecycleOutcome,
  });
  if (lifecycleOutcome === "error") {
    startupSpan.setStatus({ code: 2, message: "error" });
  }
  startupSpan.end(new Date(finishedAtMs));
  lifecycleFinished = true;

  const interactiveDurationMs = interactiveAtMs - startupStartedAtMs;
  const lifecycleDurationMs = finishedAtMs - startupStartedAtMs;
  logger.info(
    "app-startup",
    `Startup lifecycle completed: interactiveDurationMs=${interactiveDurationMs} lifecycleDurationMs=${lifecycleDurationMs} outcome=${lifecycleOutcome}`,
    {
      interactiveDurationMs,
      lifecycleDurationMs,
      outcome: lifecycleOutcome,
    },
  );
}

export function startStartupTelemetry(): StartupSpan {
  if (startupSpan) {
    return startupSpan;
  }

  const javascriptStartedAtMs = Date.now();
  const launchDurationMs = expoLaunchDurationMs();
  startupStartedAtMs = javascriptStartedAtMs - launchDurationMs;
  const channel = optionalString(Updates.channel);
  const runtimeVersion = optionalString(Updates.runtimeVersion);
  const updateId = optionalString(Updates.updateId);

  startupSpan = Sentry.startInactiveSpan({
    name: "Mobile Startup",
    op: "ui.load",
    forceTransaction: true,
    startTime: new Date(startupStartedAtMs),
    attributes: {
      "app.start.expo_launch_duration_ms": launchDurationMs,
      "app.start.expo_embedded_launch": Updates.isEmbeddedLaunch,
      ...(channel ? { "app.start.expo_channel": channel } : {}),
      ...(runtimeVersion ? { "app.start.expo_runtime_version": runtimeVersion } : {}),
      ...(updateId ? { "app.start.expo_update_id": updateId } : {}),
    },
  });

  const otaSpan = Sentry.startInactiveSpan({
    name: "OTA launch",
    op: "app.start.ota",
    parentSpan: startupSpan,
    startTime: new Date(startupStartedAtMs),
  });
  otaSpan.setAttributes({
    "app.start.duration_ms": launchDurationMs,
    "app.start.outcome": "ready",
  });
  otaSpan.end(new Date(javascriptStartedAtMs));
  logger.info(
    "app-startup",
    `Startup phase completed: phase=ota durationMs=${launchDurationMs} outcome=ready`,
    {
      durationMs: launchDurationMs,
      outcome: "ready",
      phase: "ota",
    },
  );

  startPhaseAt("javascript", javascriptStartedAtMs);
  return startupSpan;
}

export function startStartupPhase(phase: StartupPhase): void {
  startPhaseAt(phase, Date.now());
}

export function finishStartupPhase(phase: StartupPhase, outcome: StartupOutcome): void {
  const record = phases.get(phase) ?? startPhaseAt(phase, Date.now());
  if (record.finished) {
    return;
  }

  const finishedAtMs = Date.now();
  const durationMs = finishedAtMs - record.startedAtMs;
  record.span.setAttributes({
    "app.start.duration_ms": durationMs,
    "app.start.outcome": outcome,
  });
  if (outcome === "error") {
    record.span.setStatus({ code: 2, message: "error" });
    lifecycleOutcome = "error";
  }
  record.span.end(new Date(finishedAtMs));
  record.finished = true;

  logger.info(
    "app-startup",
    `Startup phase completed: phase=${phase} durationMs=${durationMs} outcome=${outcome}`,
    {
      durationMs,
      outcome,
      phase,
    },
  );
  finishLifecycleIfReady();
}

export function markAppInteractive({
  serviceBootstrapExpected,
  outcome = "ready",
}: {
  serviceBootstrapExpected: boolean;
  outcome?: "error" | "ready";
}): void {
  if (interactiveAtMs !== undefined) {
    return;
  }

  finishStartupPhase("splash-hide", outcome);
  interactiveAtMs = Date.now();
  if (!appLoadedRecorded) {
    Sentry.appLoaded();
    appLoadedRecorded = true;
  }

  if (!serviceBootstrapExpected) {
    startStartupPhase("service-bootstrap");
    finishStartupPhase("service-bootstrap", "skipped");
  }
  finishLifecycleIfReady();
}
