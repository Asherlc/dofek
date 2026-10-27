import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

const argumentsSchema = z.tuple([
  z.string().regex(/^\d+\.\d+\.\d+$/),
  z.coerce.number().int().positive(),
]);
const manifestSchema = z
  .object({
    app: z
      .object({
        version: z.object({ code: z.number().int(), name: z.string() }),
      })
      .passthrough(),
  })
  .passthrough();
const packageSchema = z.object({ version: z.string() }).passthrough();

const [version, code] = argumentsSchema.parse(process.argv.slice(2));

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

for (const path of [
  "packages/zepp/app.json",
  "packages/zepp/workout-extension/app.template.json",
]) {
  const manifest = manifestSchema.parse(await readJson(path));
  manifest.app.version = { code, name: version };
  await writeJson(path, manifest);
}

for (const path of ["packages/zepp/package.json", "packages/zepp/workout-extension/package.json"]) {
  const packageJson = packageSchema.parse(await readJson(path));
  packageJson.version = version;
  await writeJson(path, packageJson);
}
