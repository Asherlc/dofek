import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteRetainedProviderFitSource,
  deleteStagedProviderFitFiles,
  stageProviderFitFile,
} from "./provider-fit-staging.ts";

let directory: string;
const digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const input = {
  fitBuffer: Buffer.from("abc"),
  userId: "user-1",
  providerId: "wahoo",
  filename: "wahoo_42.fit",
};

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "owned-fit-staging-")));
  vi.stubEnv("JOB_FILES_DIR", directory);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("provider FIT staging", () => {
  it("keeps identical received bytes at one deterministic owned source path", async () => {
    const first = await stageProviderFitFile(input);
    const second = await stageProviderFitFile(input);
    expect(first.filePath).toBe(
      join(directory, "provider-fit", "user-1", "wahoo", digest, "wahoo_42.fit", "input.fit"),
    );
    expect(second.filePath).toBe(first.filePath);
    expect(await readFile(first.filePath)).toEqual(Buffer.from("abc"));
  });

  it("removes one owned provider while preserving the user's other provider and another user", async () => {
    const owned = await stageProviderFitFile(input);
    const otherProvider = await stageProviderFitFile({ ...input, providerId: "coros" });
    const otherUser = await stageProviderFitFile({ ...input, userId: "user-2" });
    await deleteStagedProviderFitFiles("user-1", "wahoo");
    await expect(access(owned.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(otherProvider.filePath)).toEqual(Buffer.from("abc"));
    expect(await readFile(otherUser.filePath)).toEqual(Buffer.from("abc"));
  });

  it("removes all pending providers for the erased user", async () => {
    const owned = await stageProviderFitFile(input);
    const otherProvider = await stageProviderFitFile({ ...input, providerId: "coros" });
    const otherUser = await stageProviderFitFile({ ...input, userId: "user-2" });
    await deleteStagedProviderFitFiles("user-1");
    await expect(access(owned.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(otherProvider.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(otherUser.filePath)).toEqual(Buffer.from("abc"));
  });

  it.each([{ userId: "../user-2" }, { providerId: "../coros" }, { filename: "../outside.fit" }])(
    "rejects traversing staging identity %j",
    async (invalid) => {
      await expect(stageProviderFitFile({ ...input, ...invalid })).rejects.toThrow();
    },
  );

  it("refuses a linked ownership directory before writing or deleting another owner's bytes", async () => {
    const owned = await stageProviderFitFile(input);
    await mkdir(join(directory, "provider-fit", "user-2"));
    await symlink(
      join(directory, "provider-fit", "user-1", "wahoo"),
      join(directory, "provider-fit", "user-2", "wahoo"),
    );
    await expect(stageProviderFitFile({ ...input, userId: "user-2" })).rejects.toThrow(
      "symbolic links",
    );
    await expect(deleteStagedProviderFitFiles("user-2", "wahoo")).rejects.toThrow("symbolic links");
    expect(await readFile(owned.filePath)).toEqual(Buffer.from("abc"));
  });

  it("refuses a linked FIT destination without changing the linked file", async () => {
    const staged = await stageProviderFitFile(input);
    const target = join(directory, "other-owner.fit");
    await writeFile(target, "other owner's original");
    await rm(staged.filePath);
    await symlink(target, staged.filePath);
    await expect(stageProviderFitFile(input)).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("other owner's original");
  });

  it("cleans only one recovered source and its metadata after retention", async () => {
    const first = await stageProviderFitFile(input);
    const second = await stageProviderFitFile({ ...input, filename: "wahoo_43.fit" });
    await writeFile(join(first.directory, "import.json"), "first recovery metadata");
    await writeFile(join(second.directory, "import.json"), "second recovery metadata");

    await expect(
      deleteRetainedProviderFitSource({
        ...input,
        filePath: first.filePath,
        originalPath: input.filename,
      }),
    ).resolves.toBe(true);

    await expect(access(first.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(second.filePath)).toEqual(Buffer.from("abc"));
    expect(await readFile(join(second.directory, "import.json"), "utf8")).toBe(
      "second recovery metadata",
    );
  });

  it("rejects recovery cleanup for another user's staged source", async () => {
    const staged = await stageProviderFitFile(input);
    await expect(
      deleteRetainedProviderFitSource({
        ...input,
        userId: "user-2",
        filePath: staged.filePath,
        originalPath: input.filename,
      }),
    ).rejects.toThrow("outside its ownership directory");
    expect(await readFile(staged.filePath)).toEqual(Buffer.from("abc"));
  });

  it("leaves a parent-owned ZIP extraction directory for its normal cleanup boundary", async () => {
    const source = join(directory, "file-upload-1", "extracted", "activity.fit");
    await mkdir(join(directory, "file-upload-1", "extracted"), { recursive: true });
    await writeFile(source, "ZIP original");
    await expect(
      deleteRetainedProviderFitSource({
        ...input,
        filePath: source,
        originalPath: "nested/activity.fit",
      }),
    ).resolves.toBe(false);
    expect(await readFile(source, "utf8")).toBe("ZIP original");
  });
});
