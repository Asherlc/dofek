import { z } from "zod";

export const activityHardwareItemSchema = z.object({
  id: z.string(),
  activityId: z.string(),
  providerId: z.string(),
  sourceName: z.string().nullable(),
  role: z.enum(["creator", "recorder", "sensor", "source", "category", "unknown"]),
  label: z.string(),
  model: z.string().nullable(),
  manufacturer: z.string().nullable(),
  evidence: z.string(),
  details: z.array(z.object({ label: z.string(), value: z.string() })),
});
export const activityHardwareSchema = z.object({
  items: z.array(activityHardwareItemSchema),
  power: z.array(
    z.object({
      activityId: z.string(),
      providerId: z.string(),
      kind: z.enum(["measured", "estimated"]),
      label: z.string(),
    }),
  ),
});
export type ActivityHardware = z.infer<typeof activityHardwareSchema>;
export type ActivityHardwareItem = z.infer<typeof activityHardwareItemSchema>;
export const activityHardwareRoleLabels: Record<ActivityHardwareItem["role"], string> = {
  creator: "FIT file creator",
  recorder: "Recording source",
  sensor: "Observed sensor",
  source: "Reported source",
  category: "Equipment category",
  unknown: "Reported device",
};
export function activityHardwareDetailsLabel(role: ActivityHardwareItem["role"]): string {
  return role === "creator" || role === "source" || role === "category"
    ? "Source details"
    : "Device details";
}
