import { z } from "zod";

export const requestTimezoneSchema = z
  .string()
  .min(1)
  .superRefine((timezone, context) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    } catch {
      context.addIssue({ code: "custom", message: "Invalid x-timezone header" });
    }
  })
  .default("UTC");
