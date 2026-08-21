import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./src/db/schema/account.ts",
    "./src/db/schema/activity.ts",
    "./src/db/schema/clinical.ts",
    "./src/db/schema/core.ts",
    "./src/db/schema/enums.ts",
    "./src/db/schema/events.ts",
    "./src/db/schema/nutrition.ts",
    "./src/db/schema/reference.ts",
  ],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://health:health@localhost:5435/health",
  },
});
