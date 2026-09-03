import { describe, expect, it } from "vitest";
import { parseRetryFailedFileUploadCommand } from "./retry-failed-file-upload.ts";

const required = [
  "--upload-id=00000000-0000-4000-8000-000000000001",
  "--user-id=00000000-0000-4000-8000-000000000002",
];

describe("parseRetryFailedFileUploadCommand", () => {
  it("defaults to a read-only retained-object preflight", () => {
    expect(
      parseRetryFailedFileUploadCommand([
        ...required,
        "--weight-unit=lbs",
        "--timezone=America/Los_Angeles",
      ]),
    ).toEqual({
      execute: false,
      uploadId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
      weightUnit: "lbs",
      timezone: "America/Los_Angeles",
    });
  });

  it("requires a stable job ID for an idempotent execute", () => {
    expect(
      parseRetryFailedFileUploadCommand([
        ...required,
        "--execute",
        "--job-id=file-import-repair-20260903-strong",
        "--weight-unit=lbs",
      ]),
    ).toEqual({
      execute: true,
      uploadId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
      importJobId: "file-import-repair-20260903-strong",
      weightUnit: "lbs",
    });
    expect(() => parseRetryFailedFileUploadCommand([...required, "--execute"])).toThrow(
      "--job-id is required with --execute",
    );
  });

  it.each([
    { args: required.slice(1), message: "--upload-id" },
    { args: required.slice(0, 1), message: "--user-id" },
    { args: [...required, "--weight-unit=stone"], message: "--weight-unit" },
    { args: [...required, "--timezone= "], message: "--timezone" },
  ])("rejects invalid command arguments", ({ args, message }) => {
    expect(() => parseRetryFailedFileUploadCommand(args)).toThrow(message);
  });
});
