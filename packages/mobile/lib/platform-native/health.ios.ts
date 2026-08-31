import {
  deleteDietarySamples,
  getRequestStatus,
  isAvailable,
  purgeAccountState,
  requestPermissions,
  writeDietarySamples,
} from "../../modules/health-kit";
import type { HealthGateway } from "./types";

export * from "../../modules/health-kit";

export const healthGateway: HealthGateway = {
  kind: "health-kit",
  getRequestStatus,
  requestPermissions,
  isAvailable,
  writeDietarySamples,
  deleteDietarySamples,
  purgeAccountState,
};
