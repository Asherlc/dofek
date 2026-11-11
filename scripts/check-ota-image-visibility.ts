import { z } from "zod";

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length) {
    throw new Error("Usage: pnpm tsx scripts/check-ota-image-visibility.ts");
  }
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must identify the image's owning repository");
  }
  if (!token) throw new Error("GH_TOKEN is required to verify OTA image privacy");
  const [owner, repositoryName] = repository.split("/");
  const packageName = `${repositoryName?.toLowerCase()}-ota-internal`;
  const response = await fetch(
    `https://api.github.com/users/${owner}/packages/container/${packageName}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (response.status === 404) {
    throw new Error("OTA image package must already exist and be private before publication");
  }
  if (response.status !== 200) {
    throw new Error(`Cannot verify OTA image privacy: GitHub returned HTTP ${response.status}`);
  }
  const metadata = z
    .object({
      name: z.literal(packageName),
      package_type: z.literal("container"),
      visibility: z.enum(["private", "public", "internal"]),
    })
    .parse(await response.json());
  if (metadata.visibility !== "private") {
    throw new Error(
      `OTA image package must be private; current visibility is ${metadata.visibility}`,
    );
  }
}

await main();
