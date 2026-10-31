import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import yauzl from "yauzl";
import * as archiveValidation from "../../jobs/validate-import-archive.ts";
import { ClimbingImportValidationError } from "../../lib/climbing-import-error.ts";
import {
  climbingExportZip,
  crimpdSetHeader,
  crimpdWorkoutHeader,
} from "../climbing-file-test-helpers.ts";
import { readCrimpdArchive } from "./archive.ts";

describe("Crimpd ZIP archive", () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });
  async function upload(content: Buffer | string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "crimpd-export-"));
    directories.push(directory);
    const path = join(directory, "upload.zip");
    await writeFile(path, content);
    return path;
  }
  it("reads current official CSV members without extracting archive paths", async () => {
    const path = await upload(
      await climbingExportZip({
        "workouts.csv": crimpdWorkoutHeader,
        "sets.csv": crimpdSetHeader,
        "observations.csv": "DATE,ATTRIBUTE,VALUE,UNIT",
      }),
    );
    expect(await readCrimpdArchive(path)).toMatchObject({
      workoutsCsv: crimpdWorkoutHeader,
      setsCsv: crimpdSetHeader,
    });
  });
  it("rejects malformed archives and missing or ambiguous required CSV files", async () => {
    await expect(readCrimpdArchive(await upload("not a ZIP"))).rejects.toThrow(/ZIP/i);
    await expect(
      readCrimpdArchive(await upload(await climbingExportZip({ "sets.csv": crimpdSetHeader }))),
    ).rejects.toThrow(/workouts.csv/i);
    await expect(
      readCrimpdArchive(
        await upload(
          await climbingExportZip({
            "workouts.csv": crimpdWorkoutHeader,
            "a/workouts.csv": crimpdWorkoutHeader,
            "sets.csv": crimpdSetHeader,
          }),
        ),
      ),
    ).rejects.toThrow(/duplicate/i);
  });

  it("classifies corrupt compressed CSV content even when archive metadata is valid", async () => {
    const archive = await climbingExportZip({
      "workouts.csv": crimpdWorkoutHeader,
      "sets.csv": crimpdSetHeader,
    });
    const compressedDataOffset = 30 + archive.readUInt16LE(26) + archive.readUInt16LE(28);
    archive[compressedDataOffset] = 7;
    const path = await upload(archive);
    await expect(archiveValidation.validateImportArchive(path)).resolves.toBeUndefined();
    await expect(readCrimpdArchive(path)).rejects.toMatchObject({
      name: "ClimbingImportValidationError",
      message:
        "Crimpd ZIP contains corrupt or truncated workouts.csv. Download your logbook again from Crimpd and upload the new ZIP.",
    });
  });

  it("preserves unexpected programming and filesystem errors", async () => {
    const programmingFailure = new TypeError("unexpected archive validator failure");
    vi.spyOn(archiveValidation, "validateImportArchive").mockRejectedValueOnce(programmingFailure);
    await expect(readCrimpdArchive("unread.zip")).rejects.toBe(programmingFailure);
    await expect(
      readCrimpdArchive(join(tmpdir(), "missing-crimpd-archive", "missing.zip")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  async function mockArchive(
    names: string[],
    failure?: { opening?: Error; stream?: Error; reading?: unknown; archive?: Error },
  ) {
    vi.spyOn(archiveValidation, "validateImportArchive").mockResolvedValue(undefined);
    const zip = Object.assign(await yauzl.fromBufferPromise(await climbingExportZip({})), {
      close: vi.fn(),
      readEntry: vi.fn(() => {
        queueMicrotask(() => {
          if (failure?.archive) zip.emit("error", failure.archive);
          else {
            const name = names.shift();
            if (name === undefined) zip.emit("end");
            else zip.emit("entry", { fileName: name });
          }
        });
      }),
      openReadStream: vi.fn(
        (_entry: yauzl.Entry, callback: (error: Error | null, stream?: Readable) => void) => {
          if (failure?.stream) callback(failure.stream, Readable.from(["partial CSV"]));
          else
            callback(
              null,
              Readable.from(
                (async function* () {
                  if (failure && "reading" in failure) throw failure.reading;
                  yield "csv contents";
                })(),
              ),
            );
        },
      ),
    });
    vi.spyOn(yauzl, "open").mockImplementation(
      (
        _path: string,
        options?: yauzl.Options | ((error: Error | null, archive: yauzl.ZipFile) => void),
        callback?: (error: Error | null, archive: yauzl.ZipFile) => void,
      ) => {
        expect(options).toEqual({ lazyEntries: true, validateEntrySizes: true });
        if (!callback) throw new Error("Archive callback required");
        if (failure?.opening) callback(failure.opening, zip);
        else callback(null, zip);
      },
    );
    return zip;
  }

  it("closes successful archives and skips unrelated nested members", async () => {
    const zip = await mockArchive([
      "folder/metadata.csv",
      "nested/workouts.csv",
      "nested/sets.csv",
    ]);
    await expect(readCrimpdArchive("upload.zip")).resolves.toEqual({
      workoutsCsv: "csv contents",
      setsCsv: "csv contents",
    });
    expect(zip.openReadStream).toHaveBeenCalledTimes(2);
    expect(zip.close).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(["workouts.csv", "sets.csv"])(
    "requires %s, but accepts empty CSV members",
    async (missing) => {
      const path = await upload(
        await climbingExportZip({ [missing === "sets.csv" ? "workouts.csv" : "sets.csv"]: "" }),
      );
      await expect(readCrimpdArchive(path)).rejects.toBeInstanceOf(ClimbingImportValidationError);
      const complete = await upload(
        await climbingExportZip({ "workouts.csv": "", "sets.csv": "" }),
      );
      await expect(readCrimpdArchive(complete)).resolves.toEqual({ workoutsCsv: "", setsCsv: "" });
    },
  );

  it("retains validation error identity as the cause", async () => {
    const cause = new archiveValidation.ArchiveValidationError("invalid ZIP metadata");
    vi.spyOn(archiveValidation, "validateImportArchive").mockRejectedValue(cause);
    await expect(readCrimpdArchive("upload.zip")).rejects.toMatchObject({
      name: "ClimbingImportValidationError",
      message: cause.message,
      cause,
    });
  });

  it.each(["opening", "stream", "archive"] as const)(
    "propagates %s failures unchanged and closes opened archives",
    async (stage) => {
      const failure = Object.assign(new Error("filesystem unavailable"), { code: "EIO" });
      const zip = await mockArchive(["workouts.csv"], { [stage]: failure });
      await expect(readCrimpdArchive("upload.zip")).rejects.toBe(failure);
      expect(zip.close).toHaveBeenCalledTimes(stage === "opening" ? 0 : 1);
    },
  );

  it.each(["Z_DATA_ERROR", "Z_BUF_ERROR"])(
    "classifies %s as corrupt input with its original cause",
    async (code) => {
      const failure = Object.assign(new Error("invalid compressed stream"), { code });
      const zip = await mockArchive(["workouts.csv"], { reading: failure });
      await expect(readCrimpdArchive("upload.zip")).rejects.toMatchObject({
        name: "ClimbingImportValidationError",
        cause: failure,
        message: expect.stringContaining("corrupt or truncated workouts.csv"),
      });
      expect(zip.close).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it.each([
    new TypeError("unexpected consumer error"),
    Object.assign(new Error("disk failure"), { code: "EIO" }),
    { code: "Z_DATA_ERROR", message: "non-Error rejection" },
  ])("preserves unexpected stream rejection %j", async (failure) => {
    const zip = await mockArchive(["sets.csv"], { reading: failure });
    await expect(readCrimpdArchive("upload.zip")).rejects.toBe(failure);
    expect(zip.close).toHaveBeenCalledExactlyOnceWith();
  });
});
