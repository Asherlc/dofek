import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startStorybookStaticServer } from "./storybook-static-server";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("startStorybookStaticServer", () => {
  it("rejects encoded traversal outside the Storybook root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "dofek-storybook-server-"));
    temporaryDirectories.push(parent);
    const root = join(parent, "storybook-static");
    await mkdir(root);
    await writeFile(join(root, "index.html"), "Storybook");
    await writeFile(join(parent, "secret.txt"), "secret");
    const server = await startStorybookStaticServer(root);

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/%2e%2e%2fsecret.txt`);

      expect(response.status).toBe(403);
      await expect(response.text()).resolves.toBe("Forbidden");
    } finally {
      await server.close();
    }
  });
});
