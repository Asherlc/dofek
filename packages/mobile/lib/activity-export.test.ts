import { beforeEach, describe, expect, it, vi } from "vitest";
import { downloadActivityExport } from "./activity-export";

const fileSystemMocks = vi.hoisted(() => ({
  deleteAsync: vi.fn(),
  downloadAsync: vi.fn(),
  moveAsync: vi.fn(),
  readAsStringAsync: vi.fn(),
}));
const sharingMocks = vi.hoisted(() => ({
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));
const telemetryMocks = vi.hoisted(() => ({
  captureException: vi.fn(),
}));
const cryptoMocks = vi.hoisted(() => ({
  randomUUID: vi.fn(() => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
}));

vi.mock("expo-file-system/legacy", () => ({
  deleteAsync: fileSystemMocks.deleteAsync,
  downloadAsync: fileSystemMocks.downloadAsync,
  moveAsync: fileSystemMocks.moveAsync,
  readAsStringAsync: fileSystemMocks.readAsStringAsync,
}));

vi.mock("expo-sharing", () => sharingMocks);

vi.mock("expo-crypto", () => cryptoMocks);

vi.mock("./mobile-export-cache", () => ({
  createMobileExportCacheFile: (filename: string) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)) {
      throw new Error("Export cache filename is invalid");
    }
    return { uri: `file:///cache/dofek-exports-v1/${filename}` };
  },
}));

vi.mock("./telemetry", () => telemetryMocks);

beforeEach(() => {
  vi.clearAllMocks();
  cryptoMocks.randomUUID.mockReturnValue("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  fileSystemMocks.deleteAsync.mockResolvedValue(undefined);
  fileSystemMocks.downloadAsync.mockResolvedValue({
    headers: {},
    status: 200,
    uri: "file:///cache/dofek-exports-v1/activity-12345678.fit",
  });
  sharingMocks.isAvailableAsync.mockResolvedValue(true);
  sharingMocks.shareAsync.mockResolvedValue(undefined);
});

describe("downloadActivityExport", () => {
  const input = {
    activityId: "12345678-1234-4123-8123-123456789abc",
    format: "fit" as const,
    serverUrl: "https://dofek.test/",
    sessionToken: "session-token",
  };

  it("downloads into the owned export cache and deletes the file after sharing", async () => {
    await downloadActivityExport(input);

    expect(fileSystemMocks.downloadAsync).toHaveBeenCalledWith(
      "https://dofek.test/api/activity/12345678-1234-4123-8123-123456789abc/export?format=fit",
      "file:///cache/dofek-exports-v1/export-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-activity-12345678.fit",
      {
        headers: {
          Authorization: "Bearer session-token",
        },
      },
    );
    expect(sharingMocks.shareAsync).toHaveBeenCalledWith(
      "file:///cache/dofek-exports-v1/export-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-activity-12345678.fit",
      expect.objectContaining({ mimeType: "application/vnd.ant.fit" }),
    );
    expect(fileSystemMocks.deleteAsync).toHaveBeenCalledWith(
      "file:///cache/dofek-exports-v1/export-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-activity-12345678.fit",
      { idempotent: true },
    );
  });

  it("deletes both temporary names when the server supplies a safe filename", async () => {
    fileSystemMocks.downloadAsync.mockResolvedValue({
      headers: { "content-disposition": 'attachment; filename="morning-ride.fit"' },
      status: 200,
      uri: "file:///cache/dofek-exports-v1/activity-12345678.fit",
    });

    await downloadActivityExport(input);

    expect(fileSystemMocks.moveAsync).toHaveBeenCalledWith({
      from: "file:///cache/dofek-exports-v1/export-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-activity-12345678.fit",
      to: "file:///cache/dofek-exports-v1/export-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-morning-ride.fit",
    });
    expect(fileSystemMocks.deleteAsync).toHaveBeenCalledWith(
      "file:///cache/dofek-exports-v1/export-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-activity-12345678.fit",
      { idempotent: true },
    );
    expect(fileSystemMocks.deleteAsync).toHaveBeenCalledWith(
      "file:///cache/dofek-exports-v1/export-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-morning-ride.fit",
      { idempotent: true },
    );
  });

  it("rejects an unsafe response filename without writing outside the owned cache", async () => {
    fileSystemMocks.downloadAsync.mockResolvedValue({
      headers: { "content-disposition": 'attachment; filename="../private.fit"' },
      status: 200,
      uri: "file:///cache/dofek-exports-v1/activity-12345678.fit",
    });

    await expect(downloadActivityExport(input)).rejects.toThrow(
      "Activity export filename is invalid",
    );

    expect(fileSystemMocks.moveAsync).not.toHaveBeenCalled();
    expect(fileSystemMocks.deleteAsync).toHaveBeenCalledWith(
      "file:///cache/dofek-exports-v1/export-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-activity-12345678.fit",
      { idempotent: true },
    );
  });

  it("deletes the downloaded file when the share sheet fails", async () => {
    sharingMocks.shareAsync.mockRejectedValue(new Error("share failed"));

    await expect(downloadActivityExport(input)).rejects.toThrow("share failed");

    expect(fileSystemMocks.deleteAsync).toHaveBeenCalledWith(
      "file:///cache/dofek-exports-v1/export-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-activity-12345678.fit",
      { idempotent: true },
    );
  });

  it("reports and surfaces cleanup failure after a successful share", async () => {
    fileSystemMocks.deleteAsync.mockRejectedValue(new Error("delete failed"));

    await expect(downloadActivityExport(input)).rejects.toThrow(
      "The activity export was shared, but its temporary file could not be removed.",
    );

    expect(telemetryMocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Activity export cache cleanup failed." }),
      { source: "activity-export-cache-cleanup" },
    );
  });

  it("preserves the operation failure when cleanup also fails", async () => {
    sharingMocks.shareAsync.mockRejectedValue(new Error("share failed"));
    fileSystemMocks.deleteAsync.mockRejectedValue(new Error("delete failed"));

    await expect(downloadActivityExport(input)).rejects.toThrow("share failed");

    expect(telemetryMocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Activity export cache cleanup failed." }),
      { source: "activity-export-cache-cleanup" },
    );
  });
});
