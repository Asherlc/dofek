import { z } from "zod";
import { deviceDisplayName } from "./device-names.ts";
import { providerFamily } from "./provider-catalog.ts";
import { providerSourceLogo } from "./providers.ts";

export const activityMetricSourcePresentationSchema = z.object({
  displayName: z.string(),
  providerId: z.string(),
  sourceName: z.string().nullable(),
  attribution: z
    .object({
      kind: z.enum(["apple_health", "cloud", "bluetooth"]),
      label: z.string(),
    })
    .nullable(),
});
export type ActivityMetricSourcePresentation = z.infer<
  typeof activityMetricSourcePresentationSchema
>;

export const activityMetricSourceSchema = z.object({
  id: z.string(),
  label: z.string(),
  presentation: activityMetricSourcePresentationSchema,
});
export type ActivityMetricSource = z.infer<typeof activityMetricSourceSchema>;

export function activityMetricSourcePresentation(
  providerId: string,
  sourceName: string | null,
  fullLabel: string,
): ActivityMetricSourcePresentation {
  if (providerId === "apple_health" || providerId === "apple-health") {
    const { viaAppleHealth } = providerSourceLogo(providerId, sourceName);
    return {
      displayName: viaAppleHealth
        ? deviceDisplayName(sourceName ?? "Apple Health")
        : "Apple Health",
      providerId,
      sourceName,
      attribution: viaAppleHealth ? { kind: "apple_health", label: "Apple Health" } : null,
    };
  }
  const family = providerFamily(providerId);
  if (family && (family.methodLabel === "Cloud" || family.methodLabel === "Bluetooth")) {
    return {
      displayName: family.label,
      providerId,
      sourceName,
      attribution: {
        kind: family.methodLabel === "Cloud" ? "cloud" : "bluetooth",
        label: family.methodLabel,
      },
    };
  }
  if (providerId === "ble_heart_rate") {
    return {
      displayName: sourceName ? deviceDisplayName(sourceName) : "Heart Rate Monitor",
      providerId,
      sourceName,
      attribution: { kind: "bluetooth", label: "Bluetooth" },
    };
  }
  return { displayName: fullLabel, providerId, sourceName, attribution: null };
}
