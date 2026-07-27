/** Client share UI durations that stay within the server 1–90 day contract. */
export const HEALTH_REPORT_SHARE_EXPIRY_OPTIONS = [7, 30, 90] as const;
export type HealthReportShareExpiryDays = (typeof HEALTH_REPORT_SHARE_EXPIRY_OPTIONS)[number];
export const DEFAULT_HEALTH_REPORT_SHARE_EXPIRY_DAYS: HealthReportShareExpiryDays = 7;
