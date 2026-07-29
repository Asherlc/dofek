import { z } from "zod";

export const companionConnectionTypeSchema = z.enum(["zepp-main", "zepp-workout"]);

export type CompanionConnectionType = z.infer<typeof companionConnectionTypeSchema>;

export const DEFAULT_COMPANION_CONNECTION_TYPE = "zepp-main" satisfies CompanionConnectionType;
