import { describe, expect, it, vi } from "vitest";
import { getImuConnection, postImuEnvelope } from "./imu-side-upload.ts";
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
});
