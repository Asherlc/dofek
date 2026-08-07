import { build } from "esbuild";

await build({
  entryPoints: [
    { in: "app.ts", out: "app" },
    { in: "page/index.ts", out: "page/index" },
    { in: "app-side/index.ts", out: "app-side/index" },
    { in: "setting/index.ts", out: "setting/index" },
    { in: "app-service/imu_service.ts", out: "app-service/imu_service" },
  ],
  bundle: true,
  platform: "neutral",
  target: "es2022",
  format: "esm",
  define: {
    DOFEK_COMPANION_CONNECTION_TYPE: JSON.stringify("zepp-main"),
  },
  external: ["@zos/*", "@zeppos/*"],
  outdir: ".",
  allowOverwrite: true,
});
