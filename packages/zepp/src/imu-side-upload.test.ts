import { describe, expect, it, vi } from "vitest";
import { getImuConnection, ImuUploadFailure, postImuEnvelope } from "./imu-side-upload.ts";
import { createImuChunkEnvelope } from "./imu-upload.ts";

const connection = { serverUrl: "https://dofek.test", accountId: "account-1" };

const envelope = createImuChunkEnvelope({
  connectionType: "zepp",
  installId: "install-1",
  segmentId: "segment-1",
  sessionStartMs: 1_720_000_000_000,
  sampleOffset: 0,
  accelFreqMode: 1,
  gyroFreqMode: 0,
  hasGyroscope: false,
  samples: [{ tMs: 0, sensor: "accelerometer", x: 1, y: 2, z: 3 }],
});

describe("postImuEnvelope", () => {
  it("sends to the paired server using its companion token", async () => {
    const fetch = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        status: "ok",
        acceptedEventIds: ["segment-1:0"],
        rejected: [],
      },
    });
    await expect(
      postImuEnvelope("https://dofek.test/", "companion-token", envelope, connection, fetch),
    ).resolves.toEqual({ acceptedEventIds: ["segment-1:0"], rejected: [] });
    expect(fetch).toHaveBeenCalledWith({
      url: "https://dofek.test/api/ingest/zos-imu",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer companion-token" },
      body: JSON.stringify({ ...envelope, accountId: "account-1" }),
    });
  });

  it("requires a connection and explicit server acknowledgement", async () => {
    const fetch = vi.fn();
    await expect(
      postImuEnvelope("https://dofek.test", "", envelope, connection, fetch),
    ).rejects.toThrow("Connect Dofek");
    expect(fetch).not.toHaveBeenCalled();
    for (const response of [
      {},
      { status: 200, body: {} },
      { status: 500, body: { error: "Queue unavailable" } },
    ]) {
      fetch.mockResolvedValueOnce(response);
      await expect(
        postImuEnvelope("https://dofek.test", "token", envelope, connection, fetch),
      ).rejects.toThrow();
    }
  });

  it("rejects server changes before sending captured data", async () => {
    const fetch = vi.fn();
    await expect(
      postImuEnvelope("https://other.test", "token", envelope, connection, fetch),
    ).rejects.toThrow("original Dofek server");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves the original account assertion when a token changes", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({ status: 409, body: { error: "Reconnect the original Dofek account." } });
    await expect(
      postImuEnvelope("https://dofek.test", "new-token", envelope, connection, fetch),
    ).rejects.toThrow("original Dofek account");
    expect(JSON.parse(fetch.mock.calls[0]?.[0].body)).toEqual({
      ...envelope,
      accountId: "account-1",
    });
  });

  it("requires a valid durable binding", async () => {
    const fetch = vi.fn();
    for (const binding of [undefined, {}, { serverUrl: "https://dofek.test", accountId: "" }]) {
      await expect(
        postImuEnvelope("https://dofek.test", "token", envelope, binding, fetch),
      ).rejects.toThrow("connection binding");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("trims the current token before authorizing the upload", async () => {
    const fetch = vi.fn().mockResolvedValue({
      status: 200,
      body: { status: "ok", acceptedEventIds: [], rejected: [] },
    });

    await postImuEnvelope("https://dofek.test", "  token  ", envelope, connection, fetch);

    expect(fetch.mock.calls[0]?.[0].headers.Authorization).toBe("Bearer token");
  });

  it("rejects a whitespace-only token before uploading", async () => {
    const fetch = vi.fn();
    await expect(
      postImuEnvelope("https://dofek.test", "   ", envelope, connection, fetch),
    ).rejects.toThrow("Connect Dofek");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-record binding", null],
    ["an array binding", []],
    ["a non-string server", { serverUrl: 1, accountId: "account-1" }],
    ["a non-string account", { serverUrl: "https://dofek.test", accountId: 1 }],
    ["a blank account", { serverUrl: "https://dofek.test", accountId: "  " }],
  ])("rejects %s", async (_description, binding) => {
    const fetch = vi.fn();
    await expect(
      postImuEnvelope("https://dofek.test", "token", envelope, binding, fetch),
    ).rejects.toThrow("connection binding");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a non-200 success",
      { status: 201, body: { status: "ok", acceptedEventIds: [], rejected: [] } },
    ],
    [
      "a body error",
      {
        status: 200,
        body: { status: "ok", acceptedEventIds: [], rejected: [], error: "Rejected" },
      },
    ],
    ["a missing body", { status: 200 }],
    ["a null body", { status: 200, body: null }],
    ["an array body", { status: 200, body: [] }],
    ["a string body", { status: 200, body: "invalid" }],
    ["a missing acknowledgement", { status: 200, body: {} }],
    [
      "a malformed accepted event",
      { status: 200, body: { status: "ok", acceptedEventIds: [1], rejected: [] } },
    ],
    [
      "a malformed rejection",
      {
        status: 200,
        body: {
          status: "ok",
          acceptedEventIds: [],
          rejected: [{ eventId: "event-1", issues: [{ path: 1, message: "Invalid" }] }],
        },
      },
    ],
    [
      "a negative acknowledgement",
      { status: 200, body: { status: "error", acceptedEventIds: [], rejected: [] } },
    ],
  ])("rejects %s", async (_description, response) => {
    const fetch = vi.fn().mockResolvedValue(response);
    await expect(
      postImuEnvelope("https://dofek.test", "token", envelope, connection, fetch),
    ).rejects.toBeInstanceOf(ImuUploadFailure);
  });

  it("uses the explicit server error and the acknowledgement fallback", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 503, body: { error: "Queue unavailable" } })
      .mockResolvedValueOnce({ status: 200, body: null });

    await expect(
      postImuEnvelope("https://dofek.test", "token", envelope, connection, fetch),
    ).rejects.toThrow("Queue unavailable");
    await expect(
      postImuEnvelope("https://dofek.test", "token", envelope, connection, fetch),
    ).rejects.toThrow("Dofek did not acknowledge the IMU batch");
  });
});

describe("getImuConnection", () => {
  it("obtains the token's account identity without sending sensor data", async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 200, body: { accountId: "account-1" } });
    await expect(getImuConnection("https://dofek.test/", "token", fetch)).resolves.toEqual(
      connection,
    );
    expect(fetch).toHaveBeenCalledWith({
      url: "https://dofek.test/api/ingest/zos-imu/connection",
      method: "GET",
      headers: { Authorization: "Bearer token" },
    });
  });

  it("rejects missing authentication or malformed binding responses", async () => {
    const fetch = vi.fn();
    await expect(getImuConnection("https://dofek.test", "", fetch)).rejects.toThrow(
      "Connect Dofek",
    );
    expect(fetch).not.toHaveBeenCalled();
    for (const response of [
      { status: 200, body: {} },
      { status: 401, body: { error: "Revoked" } },
      { body: { accountId: "account-1" } },
    ]) {
      fetch.mockResolvedValueOnce(response);
      await expect(getImuConnection("https://dofek.test", "token", fetch)).rejects.toThrow();
    }
  });

  it("trims the current token before resolving its account", async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 200, body: { accountId: "account-1" } });

    await getImuConnection("https://dofek.test", "  token  ", fetch);

    expect(fetch.mock.calls[0]?.[0].headers.Authorization).toBe("Bearer token");
  });

  it.each([
    ["a non-200 success", { status: 201, body: { accountId: "account-1" } }],
    ["a body error", { status: 200, body: { accountId: "account-1", error: "Rejected" } }],
    ["a missing body", { status: 200 }],
    ["a null body", { status: 200, body: null }],
    ["an array body", { status: 200, body: [] }],
    ["a non-string account", { status: 200, body: { accountId: 1 } }],
    ["a blank account", { status: 200, body: { accountId: "  " } }],
  ])("rejects %s", async (_description, response) => {
    const fetch = vi.fn().mockResolvedValue(response);
    const body = "body" in response ? response.body : undefined;
    await expect(getImuConnection("https://dofek.test", "token", fetch)).rejects.toThrow(
      body && typeof body === "object" && "error" in body
        ? "Rejected"
        : "Dofek did not return a valid IMU connection binding",
    );
  });

  it("uses the explicit server error and the binding fallback", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 503, body: { error: "Identity unavailable" } })
      .mockResolvedValueOnce({ status: 200, body: null });

    await expect(getImuConnection("https://dofek.test", "token", fetch)).rejects.toThrow(
      "Identity unavailable",
    );
    await expect(getImuConnection("https://dofek.test", "token", fetch)).rejects.toThrow(
      "Dofek did not return a valid IMU connection binding",
    );
  });

  it("rejects a whitespace-only token before resolving an account", async () => {
    const fetch = vi.fn();
    await expect(getImuConnection("https://dofek.test", "   ", fetch)).rejects.toThrow(
      "Connect Dofek",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
