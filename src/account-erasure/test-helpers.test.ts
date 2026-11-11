import { spawnSync } from "node:child_process";
import { GenericContainer } from "testcontainers";
import { expect, it, vi } from "vitest";
import { createSeaweedFsS3Container } from "./test-helpers.ts";

it("supplies authenticated S3 identity as a real tar archive using the current archiver API", async () => {
  const copy = vi.spyOn(GenericContainer.prototype, "withCopyArchivesToContainer");
  const copyContent = vi.spyOn(GenericContainer.prototype, "withCopyContentToContainer");
  try {
    createSeaweedFsS3Container({ accessKeyId: "media", secretAccessKey: "media-secret" });
    expect(copy).toHaveBeenCalledOnce();
    expect(copyContent).not.toHaveBeenCalled();
    const archive = copy.mock.calls[0]?.[0][0];
    if (!archive) throw Error("Missing S3 fixture archive");
    expect(archive.target).toBe("/");
    const chunks: Buffer[] = [];
    for await (const chunk of archive.tar) chunks.push(Buffer.from(chunk));
    const extracted = spawnSync("tar", ["-xOf", "-", "tmp/s3-test-identity.json"], {
      input: Buffer.concat(chunks),
      encoding: "utf8",
    });
    expect(extracted.status, extracted.stderr).toBe(0);
    expect(JSON.parse(extracted.stdout)).toEqual({
      identities: [
        {
          name: "storage-test",
          credentials: [{ accessKey: "media", secretKey: "media-secret" }],
          actions: ["Admin", "Read", "Write", "List", "Tagging"],
        },
      ],
    });
  } finally {
    copy.mockRestore();
    copyContent.mockRestore();
  }
});
