import { describe, expect, it, vi } from "vitest";
import { getImuConnection, postImuBatch } from "./imu-side-upload.ts";

const connection = { serverUrl: "https://dofek.test", accountId: "account-1" };

describe("postImuBatch", () => {
  it("sends to the paired server using its companion token", async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 200, body: '{"status":"ok"}' });
    const data = { data: [1, 2], sampleOffset: 128, connection };
    await expect(
      postImuBatch("https://dofek.test/", "companion-token", data, fetch),
    ).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith({
      url: "https://dofek.test/api/ingest/zos-imu",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer companion-token" },
      body: JSON.stringify({ data: [1, 2], sampleOffset: 128, accountId: "account-1" }),
    });
  });

  it("requires a connection and explicit server acknowledgement", async () => {
    const fetch = vi.fn();
    await expect(postImuBatch("https://dofek.test", "", {}, fetch)).rejects.toThrow(
      "Connect Dofek",
    );
    expect(fetch).not.toHaveBeenCalled();
    for (const response of [
      {},
      { status: 200, body: {} },
      { status: 500, body: { error: "Queue unavailable" } },
    ]) {
      fetch.mockResolvedValueOnce(response);
      await expect(
        postImuBatch("https://dofek.test", "token", { connection }, fetch),
      ).rejects.toThrow();
    }
  });

  it("rejects server changes before sending captured data", async () => {
    const fetch = vi.fn();
    await expect(
      postImuBatch("https://other.test", "token", { connection }, fetch),
    ).rejects.toThrow("original Dofek server");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves the original account assertion when a token changes", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({ status: 409, body: { error: "Reconnect the original Dofek account." } });
    await expect(
      postImuBatch(
        "https://dofek.test",
        "new-token",
        { data: [1], sampleOffset: 0, connection },
        fetch,
      ),
    ).rejects.toThrow("original Dofek account");
    expect(JSON.parse(fetch.mock.calls[0]?.[0].body)).toEqual({
      data: [1],
      sampleOffset: 0,
      accountId: "account-1",
    });
  });

  it("requires a valid durable binding", async () => {
    const fetch = vi.fn();
    for (const binding of [undefined, {}, { serverUrl: "https://dofek.test", accountId: "" }]) {
      await expect(
        postImuBatch("https://dofek.test", "token", { connection: binding }, fetch),
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
