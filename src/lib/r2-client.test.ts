import { S3Client } from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createR2Client, createS3Client, parseR2Config } from "./r2-client.ts";


describe("parseR2Config", () => {
  const validEnv = {
    R2_ENDPOINT: "https://account-id.r2.cloudflarestorage.com",
    R2_ACCESS_KEY_ID: "my-access-key",
    R2_SECRET_ACCESS_KEY: "my-secret-key",
    R2_BUCKET: "my-bucket",
  };

  it("parses valid config", () => {
    const config = parseR2Config(validEnv);
    expect(config).toEqual(validEnv);
  });

  it("rejects missing R2_ENDPOINT", () => {
    const { R2_ENDPOINT: _, ...env } = validEnv;
    expect(() => parseR2Config(env)).toThrow();
  });

  it("rejects invalid R2_ENDPOINT (not a URL)", () => {
    expect(() => parseR2Config({ ...validEnv, R2_ENDPOINT: "not-a-url" })).toThrow();
  });

  it("rejects missing R2_ACCESS_KEY_ID", () => {
    const { R2_ACCESS_KEY_ID: _, ...env } = validEnv;
    expect(() => parseR2Config(env)).toThrow();
  });

  it("rejects empty R2_ACCESS_KEY_ID", () => {
    expect(() => parseR2Config({ ...validEnv, R2_ACCESS_KEY_ID: "" })).toThrow();
  });

  it("rejects missing R2_SECRET_ACCESS_KEY", () => {
    const { R2_SECRET_ACCESS_KEY: _, ...env } = validEnv;
    expect(() => parseR2Config(env)).toThrow();
  });

  it("rejects empty R2_SECRET_ACCESS_KEY", () => {
    expect(() => parseR2Config({ ...validEnv, R2_SECRET_ACCESS_KEY: "" })).toThrow();
  });

  it("rejects missing R2_BUCKET", () => {
    const { R2_BUCKET: _, ...env } = validEnv;
    expect(() => parseR2Config(env)).toThrow();
  });

  it("rejects empty R2_BUCKET", () => {
    expect(() => parseR2Config({ ...validEnv, R2_BUCKET: "" })).toThrow();
  });
});

describe("createS3Client", () => {
  it("creates an S3Client with the correct configuration", () => {
    const config = {
      R2_ENDPOINT: "https://account-id.r2.cloudflarestorage.com",
      R2_ACCESS_KEY_ID: "my-access-key",
      R2_SECRET_ACCESS_KEY: "my-secret-key",
      R2_BUCKET: "my-bucket",
    };

    const client = createS3Client(config);
    expect(client).toBeInstanceOf(S3Client);
  });
});

describe("createR2Client", () => {
  const bucket = "test-bucket";
  let mockSend: ReturnType<typeof vi.fn>;
  let client: ReturnType<typeof createR2Client>;

  beforeEach(() => {
    mockSend = vi.fn();
    // Create a real S3Client then stub its send method
    const s3Client = new S3Client({ region: "auto" });
    s3Client.send = mockSend;
    client = createR2Client(s3Client, bucket);
  });

  describe("uploadBuffer", () => {
    it("sends a PutObjectCommand with the correct parameters", async () => {
      mockSend.mockResolvedValue({});
      const data = Buffer.from("hello world");

      await client.uploadBuffer("test-key.txt", data, "text/plain");

      expect(mockSend).toHaveBeenCalledOnce();
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            Bucket: "test-bucket",
            Key: "test-key.txt",
            Body: data,
            ContentType: "text/plain",
          },
        }),
      );
    });
  });

  describe("downloadBuffer", () => {
    it("returns the downloaded file as a Buffer", async () => {
      const content = Buffer.from("file content");
      mockSend.mockResolvedValue({
        Body: {
          transformToByteArray: vi.fn().mockResolvedValue(new Uint8Array(content)),
        },
      });

      const result = await client.downloadBuffer("test-key.txt");

      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.toString("utf-8")).toBe("file content");
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: { Bucket: "test-bucket", Key: "test-key.txt" },
        }),
      );
    });

    it("throws when response body is empty", async () => {
      mockSend.mockResolvedValue({ Body: undefined });

      await expect(client.downloadBuffer("missing-key")).rejects.toThrow(
        "Empty response body for r2://test-bucket/missing-key",
      );
    });
  });

  describe("uploadJson", () => {
    it("serializes data as JSON and uploads with application/json content type", async () => {
      mockSend.mockResolvedValue({});
      const data = { name: "test", values: [1, 2, 3] };

      await client.uploadJson("data.json", data);

      expect(mockSend).toHaveBeenCalledOnce();
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Bucket: "test-bucket",
            Key: "data.json",
            ContentType: "application/json",
          }),
        }),
      );
    });
  });

  describe("downloadJson", () => {
    const schema = z.object({
      name: z.string(),
      count: z.number(),
    });

    it("downloads, parses JSON, and validates with the provided schema", async () => {
      const jsonData = { name: "test", count: 42 };
      const content = Buffer.from(JSON.stringify(jsonData));
      mockSend.mockResolvedValue({
        Body: {
          transformToByteArray: vi.fn().mockResolvedValue(new Uint8Array(content)),
        },
      });

      const result = await client.downloadJson("data.json", schema);

      expect(result).toEqual(jsonData);
    });

    it("throws when downloaded JSON does not match schema", async () => {
      const invalidData = { wrong: "shape" };
      const content = Buffer.from(JSON.stringify(invalidData));
      mockSend.mockResolvedValue({
        Body: {
          transformToByteArray: vi.fn().mockResolvedValue(new Uint8Array(content)),
        },
      });

      await expect(client.downloadJson("data.json", schema)).rejects.toThrow();
    });

    it("throws when downloaded content is not valid JSON", async () => {
      const content = Buffer.from("not json {{{");
      mockSend.mockResolvedValue({
        Body: {
          transformToByteArray: vi.fn().mockResolvedValue(new Uint8Array(content)),
        },
      });

      await expect(client.downloadJson("data.json", schema)).rejects.toThrow();
    });
  });
});
