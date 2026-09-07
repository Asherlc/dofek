import { beforeEach, describe, expect, it, vi } from "vitest";

const mockS3Client = vi.hoisted(() =>
  vi.fn(function vitestConstructor() {
    return {};
  }),
);

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: mockS3Client,
}));

import { createR2Client } from "./r2-storage.ts";

describe("createR2Client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses path-style addressing for local HTTP-compatible object storage", () => {
    createR2Client({
      accessKeyId: "access-key",
      endpoint: "http://account-erasure-minio:9000",
      secretAccessKey: "secret-key",
    });

    expect(mockS3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "http://account-erasure-minio:9000",
        forcePathStyle: true,
      }),
    );
  });

  it("keeps virtual-host addressing for Cloudflare R2", () => {
    createR2Client({
      accessKeyId: "access-key",
      endpoint: "https://account.r2.cloudflarestorage.com",
      secretAccessKey: "secret-key",
    });

    expect(mockS3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "https://account.r2.cloudflarestorage.com",
        forcePathStyle: false,
      }),
    );
  });
});
