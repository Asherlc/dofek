import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const filesystemBoundary = vi.hoisted(() => ({
  mkdir: vi.fn<typeof import("node:fs/promises").mkdir>(),
  rm: vi.fn<typeof import("node:fs/promises").rm>(),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  mkdir: filesystemBoundary.mkdir,
  rm: filesystemBoundary.rm,
}));
let actualFilesystem: typeof import("node:fs/promises");

type StagingModule = typeof import("./provider-fit-staging.ts");
let deleteRetainedProviderFitSource: StagingModule["deleteRetainedProviderFitSource"];
let deleteStagedProviderFitFiles: StagingModule["deleteStagedProviderFitFiles"];
let stageProviderFitFile: StagingModule["stageProviderFitFile"];

let directory: string;
const digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const input = {
  fitBuffer: Buffer.from("abc"),
  userId: "user-1",
  providerId: "wahoo",
  filename: "wahoo_42.fit",
};

beforeEach(async () => {
  actualFilesystem = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  filesystemBoundary.mkdir.mockImplementation(actualFilesystem.mkdir);
  filesystemBoundary.rm.mockImplementation(actualFilesystem.rm);
  vi.resetModules();
  ({ deleteRetainedProviderFitSource, deleteStagedProviderFitFiles, stageProviderFitFile } =
    await import("./provider-fit-staging.ts"));
  directory = await realpath(await mkdtemp(join(tmpdir(), "owned-fit-staging-")));
  vi.stubEnv("JOB_FILES_DIR", directory);
});

afterEach(async () => {
  filesystemBoundary.mkdir.mockImplementation(actualFilesystem.mkdir);
  filesystemBoundary.rm.mockImplementation(actualFilesystem.rm);
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
      await expect(stageProviderFitFile({ ...input, ...invalid })).rejects.toMatchObject({
        name: "ZodError",
      });
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

  it("creates a missing job-files root when staging received bytes", async () => {
    const missingRoot = join(directory, "new-job-files");
    vi.stubEnv("JOB_FILES_DIR", missingRoot);
    const staged = await stageProviderFitFile(input);
    expect(await readFile(staged.filePath)).toEqual(Buffer.from("abc"));
  });

  it.each([
    { userId: "a", providerId: "b", filename: "c.fit" },
    { userId: "A0_-", providerId: "B9_-", filename: "activity.42_-FIT.fit" },
  ])("stages valid ownership and filenames %j", async (identity) => {
    const staged = await stageProviderFitFile({ ...input, ...identity });
    expect(await readFile(staged.filePath)).toEqual(Buffer.from("abc"));
    expect(staged.filePath).toBe(
      join(
        directory,
        "provider-fit",
        identity.userId,
        identity.providerId,
        digest,
        identity.filename,
        "input.fit",
      ),
    );
  });

  it.each([
    { userId: "!user-1" },
    { userId: "user-1!" },
    { userId: "_user-1" },
    { providerId: "!wahoo" },
    { providerId: "wahoo!" },
    { filename: "!activity.fit" },
    { filename: "activity.fit!" },
  ])("rejects invalid identity before creating source files %j", async (invalid) => {
    await expect(stageProviderFitFile({ ...input, ...invalid })).rejects.toMatchObject({
      name: "ZodError",
    });
    expect(await readdir(directory)).toEqual([]);
  });

  it("treats an absent configured root as no retained staging source", async () => {
    const missingRoot = join(directory, "missing-job-files");
    vi.stubEnv("JOB_FILES_DIR", missingRoot);
    await expect(
      deleteRetainedProviderFitSource({
        filePath: join(
          missingRoot,
          "provider-fit",
          "user-1",
          "wahoo",
          digest,
          input.filename,
          "input.fit",
        ),
        originalPath: input.filename,
        userId: input.userId,
        providerId: input.providerId,
      }),
    ).resolves.toBe(false);
    await expect(
      deleteStagedProviderFitFiles(input.userId, input.providerId),
    ).resolves.toBeUndefined();
    await expect(access(missingRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { existingSegments: [] },
    { existingSegments: ["provider-fit"] },
    { existingSegments: ["provider-fit", "user-1"] },
  ])(
    "does not create missing ownership directories during deletion %j",
    async ({ existingSegments }) => {
      await mkdir(join(directory, ...existingSegments), { recursive: true });
      await expect(
        deleteStagedProviderFitFiles(input.userId, input.providerId),
      ).resolves.toBeUndefined();
      expect(await readdir(join(directory, ...existingSegments))).toEqual([]);
    },
  );

  it.each(["short", `x${digest}`, `${digest}x`])(
    "rejects cleanup of a source with an invalid content identifier %s",
    async (invalidDigest) => {
      const sourceDirectory = join(
        directory,
        "provider-fit",
        input.userId,
        input.providerId,
        invalidDigest,
        input.filename,
      );
      await mkdir(sourceDirectory, { recursive: true });
      const filePath = join(sourceDirectory, "input.fit");
      await writeFile(filePath, "original bytes");
      await expect(
        deleteRetainedProviderFitSource({ ...input, filePath, originalPath: input.filename }),
      ).rejects.toThrow("outside its ownership directory");
      expect(await readFile(filePath, "utf8")).toBe("original bytes");
    },
  );

  it("rejects cleanup of a different file inside a valid logical source directory", async () => {
    const staged = await stageProviderFitFile(input);
    const otherFile = join(staged.directory, "another.fit");
    await writeFile(otherFile, "another original");
    await expect(
      deleteRetainedProviderFitSource({
        ...input,
        filePath: otherFile,
        originalPath: input.filename,
      }),
    ).rejects.toThrow("outside its ownership directory");
    expect(await readFile(staged.filePath)).toEqual(Buffer.from("abc"));
    expect(await readFile(otherFile, "utf8")).toBe("another original");
  });

  it("repeated source cleanup succeeds without recreating the logical source", async () => {
    const staged = await stageProviderFitFile(input);
    await deleteRetainedProviderFitSource({
      ...input,
      filePath: staged.filePath,
      originalPath: input.filename,
    });
    filesystemBoundary.mkdir.mockRejectedValue(new Error("Filesystem is not writable"));
    await expect(
      deleteRetainedProviderFitSource({
        ...input,
        filePath: staged.filePath,
        originalPath: input.filename,
      }),
    ).resolves.toBe(true);
    await expect(access(staged.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["source", "provider"])(
    "finishes %s cleanup if the path disappears immediately before removal",
    async (scope) => {
      const staged = await stageProviderFitFile(input);
      const actualRemove = actualFilesystem.rm;
      filesystemBoundary.rm.mockImplementation(async (path, options) => {
        await actualRemove(path, { recursive: true, force: true });
        await actualRemove(path, options);
      });
      const deletion =
        scope === "source"
          ? deleteRetainedProviderFitSource({
              ...input,
              filePath: staged.filePath,
              originalPath: input.filename,
            })
          : deleteStagedProviderFitFiles(input.userId, input.providerId);
      await expect(deletion).resolves.toBe(scope === "source" ? true : undefined);
      await expect(access(staged.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
