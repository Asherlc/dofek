import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import mobileApp from "../packages/mobile/app.json";

const channelPageSchema = z.object({ currentPage: z.array(z.object({ name: z.string() })) });
const channelMappingSchema = z.object({
  currentPage: z.object({
    name: z.string(),
    updateBranches: z.array(z.object({ name: z.string() })),
  }),
});

interface PreviewChannelOptions {
  channel: string;
  projectId: string;
  expoToken: string;
  runCommand(
    arguments_: string[],
    directory: string,
    environment: NodeJS.ProcessEnv,
  ): { status: number | null; stdout: string; stderr: string; error?: Error };
}

/** Ensure a preview's Expo channel links exclusively to its same-named branch. */
export async function ensureMobilePreviewChannel(options: PreviewChannelOptions) {
  const { channel, projectId, expoToken, runCommand } = options;
  if (!/^pr-\d+$/.test(channel)) throw new Error("Preview channel must be pr-<number>");
  if (!projectId.trim()) throw new Error("EXPO_APP_ID is required");
  if (!expoToken.trim()) throw new Error("EXPO_TOKEN is required");

  const directory = await mkdtemp(join(tmpdir(), "dofek-preview-channel-"));
  try {
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: mobileApp.expo.slug }));
    await writeFile(
      join(directory, "app.json"),
      JSON.stringify({
        expo: {
          name: mobileApp.expo.name,
          slug: mobileApp.expo.slug,
          extra: { eas: { projectId } },
        },
      }),
    );

    function eas(arguments_: string[]): unknown {
      const result = runCommand(
        ["dlx", "eas-cli@25.3.0", ...arguments_, "--json", "--non-interactive"],
        directory,
        { ...process.env, EXPO_TOKEN: expoToken },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`EAS ${arguments_[0]} failed: ${result.stderr}`);
      return JSON.parse(result.stdout);
    }

    let exists = false;
    for (let offset = 0; ; offset += 25) {
      const { currentPage } = channelPageSchema.parse(
        eas(["channel:list", "--limit", "25", "--offset", String(offset)]),
      );
      if (currentPage.some((row) => row.name === channel)) {
        exists = true;
        break;
      }
      if (currentPage.length < 25) break;
    }
    if (!exists) eas(["channel:create", channel]);
    const { currentPage } = channelMappingSchema.parse(eas(["channel:view", channel]));
    if (
      currentPage.name !== channel ||
      currentPage.updateBranches.length !== 1 ||
      currentPage.updateBranches[0]?.name !== channel
    ) {
      throw new Error(`Preview channel ${channel} is not mapped exclusively to ${channel}`);
    }
    return exists ? "existing" : "created";
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = await ensureMobilePreviewChannel({
    channel: process.argv[2] ?? "",
    projectId: process.env.EXPO_APP_ID ?? "",
    expoToken: process.env.EXPO_TOKEN ?? "",
    runCommand: (arguments_, directory, environment) =>
      spawnSync("pnpm", arguments_, { cwd: directory, env: environment, encoding: "utf8" }),
  });
  console.log(`Preview channel ${process.argv[2]}: ${result}`);
}
