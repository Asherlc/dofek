export interface VisibleSessionState {
  hasCredentials: boolean;
  hasImuConnection: boolean;
  logging: boolean;
  visible: boolean;
  transferInProgress: boolean;
}

export interface VisibleSessionStartActions {
  startLogging(): void;
}

export interface VisibleSessionFinalizeActions {
  cancelTransfer(): void;
  stopLogging(): void;
  transferStoppedSession(): void;
}

export interface ImuTransferConfirmation extends Record<string, unknown> {
  segmentId: string;
  source: "zepp" | "zepp-workout";
  sampleCount: number;
}

export function startVisibleSession(
  state: Pick<VisibleSessionState, "hasCredentials" | "hasImuConnection" | "logging" | "visible">,
  actions: VisibleSessionStartActions,
): void {
  if (state.visible && state.hasCredentials && state.hasImuConnection && !state.logging) {
    actions.startLogging();
  }
}

export function finalizeVisibleSession(
  state: Pick<VisibleSessionState, "logging" | "transferInProgress">,
  actions: VisibleSessionFinalizeActions,
): void {
  if (state.transferInProgress) actions.cancelTransfer();
  if (state.logging) actions.stopLogging();
  actions.transferStoppedSession();
}

export function finalizeVisibleSessionOnAccessLoss(
  state: Pick<
    VisibleSessionState,
    "hasCredentials" | "hasImuConnection" | "logging" | "transferInProgress"
  >,
  actions: VisibleSessionFinalizeActions,
): void {
  if (!state.hasCredentials || !state.hasImuConnection) {
    if (state.transferInProgress) actions.cancelTransfer();
    if (state.logging) actions.stopLogging();
  }
}

export function getImuTransferFailureReason(
  event: Record<string, unknown>,
  fallback: string,
): string | null {
  const readyState = String(event.readyState ?? "");
  if (readyState !== "error" && readyState !== "canceled") return null;
  if (typeof event.error === "string" && event.error.trim()) return event.error.trim();
  return readyState === "canceled" ? "IMU transfer was canceled." : fallback;
}

export async function confirmImuTransferPersistence(
  confirmation: ImuTransferConfirmation,
  request: (payload: {
    method: "imu.transferComplete";
    params: ImuTransferConfirmation;
  }) => Promise<unknown>,
): Promise<void> {
  const response = await request({ method: "imu.transferComplete", params: confirmation });
  if (
    typeof response !== "object" ||
    response === null ||
    !("ok" in response) ||
    response.ok !== true
  ) {
    throw new Error("Phone did not confirm the IMU binary backup.");
  }
}
