import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { ZodType } from "zod";

const mobileRequire = createRequire(new URL("../packages/mobile/package.json", import.meta.url));
const expoRequire = createRequire(mobileRequire.resolve("expo/package.json"));
const cliRequire = createRequire(expoRequire.resolve("@expo/cli/package.json"));
const { z }: typeof import("zod") = cliRequire("zod");

// Oversized constrained input must be rejected before walking its elements.
// https://github.com/colinhacks/zod/commit/a0ebf97
let visited = 0;
const item = z.string().superRefine(() => {
  visited += 1;
});
assert.equal(z.array(item).max(1).safeParse(["one", "two"]).success, false);
assert.equal(visited, 0, "Expo's Zod must reject oversized arrays before parsing elements");

const { PluginSchema, DevToolsPluginOutputSchema }: Record<string, ZodType> = cliRequire(
  "./build/src/start/server/DevToolsPlugin.schema.js",
);
const {
  createMCPDevToolsExtensionSchema,
}: { createMCPDevToolsExtensionSchema(plugin: unknown): ZodType } = cliRequire(
  "./build/src/start/server/createMCPDevToolsExtensionSchema.js",
);

const plugin = {
  packageName: "test-plugin",
  packageRoot: "/test-plugin",
  cliExtensions: {
    description: "Schema compatibility check",
    entryPoint: "./index.js",
    commands: [
      {
        name: "inspect",
        title: "Inspect a record",
        environments: ["cli", "mcp"],
        parameters: [
          { name: "label", type: "text" },
          { name: "count", type: "number" },
          { name: "confirm", type: "confirm" },
        ],
      },
    ],
  },
};
assert.ok(PluginSchema);
assert.deepEqual(PluginSchema.parse(plugin), plugin);
assert.equal(PluginSchema.safeParse({ ...plugin, packageName: "" }).success, false);

const schema = createMCPDevToolsExtensionSchema(plugin);
const command = { command: "inspect", label: "record", count: 2, confirm: true };
assert.deepEqual(schema.parse(command), command);
assert.deepEqual(schema.parse({ command: "inspect" }), { command: "inspect" });
for (const invalid of [
  { command: "unknown" },
  { ...command, count: "two" },
  { ...command, confirm: "yes" },
  { ...command, label: 2 },
  { ...command, extra: true },
]) {
  assert.equal(schema.safeParse(invalid).success, false);
}
assert.throws(() => createMCPDevToolsExtensionSchema({ packageName: "empty" }));

const output = [
  { type: "text", text: "Done", level: "info" },
  { type: "image", url: "https://example.com/image.png" },
  { type: "audio", url: "https://example.com/audio.mp3", text: "Audio" },
];
assert.ok(DevToolsPluginOutputSchema);
assert.deepEqual(DevToolsPluginOutputSchema.parse(output), output);
assert.equal(
  DevToolsPluginOutputSchema.safeParse([{ type: "image", url: "invalid" }]).success,
  false,
);
console.log("Expo Zod security and schema compatibility checks passed.");
