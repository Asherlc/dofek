import type { DietarySample } from "../../modules/health-kit";

export interface HealthGateway {
  readonly kind: "health-kit" | "health-connect";
  getRequestStatus(): Promise<"unnecessary" | "shouldRequest" | "unavailable" | "unknown">;
  requestPermissions(): Promise<boolean>;
  isAvailable(): boolean;
  writeDietarySamples(samples: DietarySample[]): Promise<boolean>;
  deleteDietarySamples(syncIdentifiers: string[]): Promise<number>;
  purgeAccountState(deviceErasureCutoff: string): Promise<boolean>;
}
