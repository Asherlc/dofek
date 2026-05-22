export const DEFAULT_PROVIDER_PRIORITY = 100;
export const DEFAULT_SENSOR_PROVIDER_PRIORITY = 1000;

export const providerPriorityTableNames = [
  "provider_priority",
  "device_priority",
  "sensor_provider_priority",
  "sensor_device_priority",
] as const;

export type ProviderPriorityTableName = (typeof providerPriorityTableNames)[number];
