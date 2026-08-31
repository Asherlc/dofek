import {
  addSampleUpdateListener,
  completeAnchoredQuery,
  completeObserverUpdates,
  deleteDietarySamples,
  enableBackgroundDelivery,
  getRequestStatus,
  hasEverAuthorized,
  isAvailable,
  isBackgroundDeliveryEnabled,
  purgeAccountState,
  queryAnchoredSamples,
  queryDailyStatistics,
  queryQuantitySamples,
  querySleepSamples,
  queryWorkoutRoutes,
  queryWorkouts,
  requestPermissions as requestNativePermissions,
  setObserverSyncInProgress,
  setupBackgroundObservers,
  teardownBackgroundObservers,
  writeDietarySamples,
} from "../../modules/health-connect";
import { captureException } from "../telemetry";

export type {
  DailyStatistic,
  DietarySample,
  HealthKitSample,
  HealthKitSampleUpdate,
  RouteLocation,
  SleepSample,
  WorkoutSample,
} from "../../modules/health-connect";

import type { HealthGateway } from "./types";

export {
  addSampleUpdateListener,
  completeAnchoredQuery,
  completeObserverUpdates,
  deleteDietarySamples,
  enableBackgroundDelivery,
  getRequestStatus,
  hasEverAuthorized,
  isBackgroundDeliveryEnabled,
  isAvailable,
  purgeAccountState,
  queryAnchoredSamples,
  queryDailyStatistics,
  queryQuantitySamples,
  querySleepSamples,
  queryWorkoutRoutes,
  queryWorkouts,
  setObserverSyncInProgress,
  setupBackgroundObservers,
  teardownBackgroundObservers,
  writeDietarySamples,
};

export async function requestPermissions(): Promise<boolean> {
  try {
    return await requestNativePermissions();
  } catch (error) {
    captureException(error, { source: "health-connect-request-permissions" });
    throw error;
  }
}

export const healthGateway: HealthGateway = {
  kind: "health-connect",
  getRequestStatus,
  requestPermissions,
  isAvailable,
  writeDietarySamples,
  deleteDietarySamples,
  purgeAccountState,
};
