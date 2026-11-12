import { NativeModule, requireNativeModule } from "expo";

export interface BackgroundRefreshEvent {
  taskId: string;
}

export interface HealthKitSyncExpiredEvent {
  taskId: string;
}

export interface HealthKitSyncStartResult {
  supported: boolean;
}

export interface BackgroundRefreshDiagnosticEvent {
  eventId: string;
  occurredAt: string;
  nativeSessionId: string;
  processId: number;
  event: string;
  taskId?: string;
  taskIdentifier?: string;
  earliestBeginAt?: string;
  success?: boolean;
  reason?: string;
  backgroundRefreshStatus?: string;
  lowPowerModeEnabled?: boolean;
  errorDomain?: string;
  errorCode?: number;
  errorDescription?: string;
}

export interface BackgroundRefreshDiagnosticHistory {
  events: BackgroundRefreshDiagnosticEvent[];
  overflowCount: number;
}

type BackgroundRefreshEvents = {
  onBackgroundRefresh: (event: BackgroundRefreshEvent) => void;
  onHealthKitSyncExpired: (event: HealthKitSyncExpiredEvent) => void;
};

declare class BackgroundRefreshNativeModule extends NativeModule<BackgroundRefreshEvents> {
  enableCollectionNotifications(requestPermission: boolean): Promise<boolean>;
  disableCollectionNotifications(): void;
  getDiagnostics(): BackgroundRefreshDiagnosticHistory;
  clearDiagnostics(): void;
  recordRefreshReceived(taskId: string): void;
  completeRefresh(taskId: string, success: boolean): void;
  isAvailable(): boolean;
  scheduleRefresh(): void;
  startHealthKitSync(taskId: string): Promise<HealthKitSyncStartResult>;
  updateHealthKitSyncProgress(
    taskId: string,
    completed: number,
    total: number,
    message: string,
  ): void;
  completeHealthKitSync(taskId: string, success: boolean): void;
}

export default requireNativeModule<BackgroundRefreshNativeModule>("BackgroundRefresh");
