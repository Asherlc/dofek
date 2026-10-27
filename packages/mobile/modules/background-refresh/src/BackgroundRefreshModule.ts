import { NativeModule, requireNativeModule } from "expo";

export interface BackgroundRefreshEvent {
  taskId: string;
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
}

export default requireNativeModule<BackgroundRefreshNativeModule>("BackgroundRefresh");
