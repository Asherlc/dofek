import { requireNativeModule } from "expo";

type SleepWidgetNativeModule = {
  replaceSnapshot(snapshot: string | null): void;
};

const SleepWidget = requireNativeModule<SleepWidgetNativeModule>("SleepWidget");

/** Atomically replace or clear the Sleep widget App Group snapshot and reload timelines. */
export function replaceSnapshot(snapshot: string | null): void {
  SleepWidget.replaceSnapshot(snapshot);
}
