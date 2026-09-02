import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const appId = Number(process.env.ZEPP_WORKOUT_EXTENSION_APP_ID);
if (!Number.isSafeInteger(appId) || appId < 1_000_000) {
  throw new Error(
    "ZEPP_WORKOUT_EXTENSION_APP_ID must be set to the numeric app ID provisioned in the Zepp developer console.",
  );
}

const templateText = await readFile("workout-extension/app.template.json", "utf8");
const template: unknown = JSON.parse(templateText);
if (typeof template !== "object" || template === null || !("app" in template)) {
  throw new Error("workout-extension/app.template.json is missing its app configuration.");
}
const app = template.app;
if (typeof app !== "object" || app === null) {
  throw new Error("workout-extension/app.template.json has an invalid app configuration.");
}
Reflect.set(app, "appId", appId);
await writeFile("workout-extension/app.json", `${JSON.stringify(template, null, 2)}\n`);
await Promise.all([
  mkdir("workout-extension/assets/common.r", { recursive: true }),
  mkdir("workout-extension/assets/common.s", { recursive: true }),
]);
await Promise.all([
  copyFile("assets/icon.png", "workout-extension/assets/common.r/icon.png"),
  copyFile("assets/icon.png", "workout-extension/assets/common.s/icon.png"),
]);

await build({
  entryPoints: [
    { in: "workout-extension/app.ts", out: "app" },
    { in: "workout-extension/data-widget/index.ts", out: "data-widget/index" },
    { in: "app-side/index.ts", out: "app-side/index" },
    { in: "workout-extension/setting/index.ts", out: "setting/index" },
  ],
  bundle: true,
  platform: "neutral",
  target: "es2022",
  format: "esm",
  define: {
    DOFEK_COMPANION_CONNECTION_TYPE: JSON.stringify("zepp-workout"),
  },
  external: ["@zos/*", "@zeppos/*"],
  outdir: "workout-extension",
  allowOverwrite: true,
});
