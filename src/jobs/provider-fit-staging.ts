import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const segmentSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Invalid FIT staging ownership");
const filenameSchema = z.string().regex(/^[A-Za-z0-9._-]+\.fit$/, "Invalid FIT staging filename");

function jobFilesDirectory(): string {
  return process.env.JOB_FILES_DIR ?? join(tmpdir(), "dofek-job-files");
}

function ownedDirectory(segments: string[], create: true): Promise<string>;
function ownedDirectory(segments: string[], create: false): Promise<string | undefined>;
async function ownedDirectory(segments: string[], create: boolean): Promise<string | undefined> {
  const root = jobFilesDirectory();
  if (create) await mkdir(root, { recursive: true });
  else if (!existsSync(root)) return undefined;
  let directory = await realpath(root);
  for (const segment of ["provider-fit", ...segments]) {
    directory = join(directory, segment);
    if (create) await mkdir(directory, { recursive: true });
    else if (!existsSync(directory)) return undefined;
    if ((await lstat(directory)).isSymbolicLink()) {
      throw new Error("FIT staging ownership must not use symbolic links");
    }
  }
  return directory;
}

export async function stageProviderFitFile(input: {
  fitBuffer: Buffer;
  userId: string;
  providerId: string;
  filename: string;
}): Promise<{ filePath: string; directory: string }> {
  const segments = [segmentSchema.parse(input.userId), segmentSchema.parse(input.providerId)];
  const filename = filenameSchema.parse(input.filename);
  const digest = createHash("sha256").update(input.fitBuffer).digest("hex");
  const directory = await ownedDirectory([...segments, digest, filename], true);
  const filePath = join(directory, "input.fit");
  await writeFile(filePath, input.fitBuffer, {
    flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
  });
  return { filePath, directory };
}

export async function deleteRetainedProviderFitSource(input: {
  filePath: string;
  originalPath: string;
  userId: string;
  providerId: string;
}): Promise<boolean> {
  const root = jobFilesDirectory();
  if (!existsSync(root)) return false;
  const stagingRoot = join(await realpath(root), "provider-fit");
  const filePath = resolve(input.filePath);
  if (!filePath.startsWith(`${stagingRoot}${sep}`)) return false;
  const segments = [segmentSchema.parse(input.userId), segmentSchema.parse(input.providerId)];
  const [digest] = relative(join(stagingRoot, ...segments), filePath).split(sep);
  const filename = filenameSchema.parse(input.originalPath);
  if (
    !digest ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    filePath !== join(stagingRoot, ...segments, digest, filename, "input.fit")
  ) {
    throw new Error("FIT staging source is outside its ownership directory");
  }
  const directory = await ownedDirectory([...segments, digest, filename], false);
  if (directory) await rm(directory, { recursive: true, force: true });
  return true;
}

export async function deleteStagedProviderFitFiles(
  userId: string,
  providerId?: string,
): Promise<void> {
  const segments = [segmentSchema.parse(userId)];
  if (providerId !== undefined) segments.push(segmentSchema.parse(providerId));
  const directory = await ownedDirectory(segments, false);
  if (directory) await rm(directory, { recursive: true, force: true });
}
