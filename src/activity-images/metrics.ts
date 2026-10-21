import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("dofek-activity-images", "1.0.0");
export const activityImageAcquisitions = meter.createCounter("activity_image.acquisition.total", {
  description: "Activity image acquisition outcomes",
  unit: "{images}",
});
export const activityImageBytes = meter.createCounter("activity_image.bytes.total", {
  description: "Original image bytes copied to private storage",
  unit: "By",
});
