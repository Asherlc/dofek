import type { HealthStatusMetric } from "dofek-server/mobile-dashboard-contracts";
import {
  healthMetricIntentSchema,
  healthMetricKeySchema,
  healthStatusMetricSchema,
} from "dofek-server/mobile-dashboard-contracts";

export { healthMetricIntentSchema, healthMetricKeySchema, healthStatusMetricSchema };
export type { HealthStatusMetric };
export type HealthMetricKey = HealthStatusMetric["metric"];
