import { NativeModule, requireNativeModule } from "expo-modules-core";

export interface BackgroundRefreshEvent {
  taskId: string;
}

type BackgroundRefreshEvents = {
  onBackgroundRefresh: (event: BackgroundRefreshEvent) => void;
};

declare class BackgroundRefreshNativeModule extends NativeModule<BackgroundRefreshEvents> {
  completeRefresh(taskId: string, success: boolean): void;
  isAvailable(): boolean;
  scheduleRefresh(): void;
}

export default requireNativeModule<BackgroundRefreshNativeModule>("BackgroundRefresh");
