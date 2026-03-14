import { afterEach, describe, expect, it } from "vitest";
import { waitForAuthCode } from "../callback-server.ts";

describe("waitForAuthCode", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = undefined;
    }
  });

  it("resolves with the authorization code on /callback?code=...", async () => {
    // Use HTTP mode to avoid self-signed cert complexity in tests
    const port = 19876;
    const promise = waitForAuthCode(port, { https: false });

    // Give the server a moment to start
    await new Promise((r) => setTimeout(r, 200));

    const response = await fetch(`http://localhost:${port}/callback?code=test-auth-code`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Authorized");

    const result = await promise;
    expect(result.code).toBe("test-auth-code");
    cleanup = result.cleanup;
  });

  it("returns 404 for non-callback paths", async () => {
    const port = 19877;
    const promise = waitForAuthCode(port, { https: false });

    await new Promise((r) => setTimeout(r, 200));

    const response = await fetch(`http://localhost:${port}/other-path`);
    expect(response.status).toBe(404);

    // Clean up by sending a valid callback
    await fetch(`http://localhost:${port}/callback?code=cleanup`);
    const result = await promise;
    cleanup = result.cleanup;
  });

  it("rejects when OAuth error is returned", async () => {
    const port = 19878;
    const promise = waitForAuthCode(port, { https: false });
    // Catch so the rejection doesn't become unhandled while we fetch
    const caught = promise.catch((e: Error) => e);

    await new Promise((r) => setTimeout(r, 200));

    const response = await fetch(`http://localhost:${port}/callback?error=access_denied`);
    expect(response.status).toBe(400);

    const error = await caught;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("OAuth authorization denied: access_denied");
  });

  it("supports custom paramName", async () => {
    const port = 19879;
    const promise = waitForAuthCode(port, { https: false, paramName: "authorization_code" });

    await new Promise((r) => setTimeout(r, 200));

    await fetch(`http://localhost:${port}/callback?authorization_code=custom-code`);

    const result = await promise;
    expect(result.code).toBe("custom-code");
    cleanup = result.cleanup;
  });

  it("returns 404 for /callback without code or error params", async () => {
    const port = 19880;
    const promise = waitForAuthCode(port, { https: false });

    await new Promise((r) => setTimeout(r, 200));

    // /callback with no params — should get 404 (falls through)
    const response = await fetch(`http://localhost:${port}/callback`);
    expect(response.status).toBe(404);

    // Clean up by sending a valid callback
    await fetch(`http://localhost:${port}/callback?code=cleanup`);
    const result = await promise;
    cleanup = result.cleanup;
  });

  it("starts HTTPS server with self-signed certificate", async () => {
    const port = 19881;
    const promise = waitForAuthCode(port, { https: true });

    await new Promise((r) => setTimeout(r, 500));

    // Use Node's https module with rejectUnauthorized: false for self-signed cert
    const https = await import("node:https");
    const result = await new Promise<{ code: string; statusCode: number }>((resolve, reject) => {
      const req = https.get(
        `https://localhost:${port}/callback?code=https-test-code`,
        { rejectUnauthorized: false },
        (res) => {
          let _body = "";
          res.on("data", (chunk: Buffer) => {
            _body += chunk.toString();
          });
          res.on("end", () => {
            resolve({ code: "https-test-code", statusCode: res.statusCode ?? 0 });
          });
        },
      );
      req.on("error", reject);
    });

    expect(result.statusCode).toBe(200);

    const authResult = await promise;
    expect(authResult.code).toBe("https-test-code");
    cleanup = authResult.cleanup;
  });

  it("defaults to HTTPS when no options provided", async () => {
    const port = 19882;
    const promise = waitForAuthCode(port);

    await new Promise((r) => setTimeout(r, 500));

    // Use Node's https module for self-signed cert
    const https = await import("node:https");
    await new Promise<void>((resolve, reject) => {
      const req = https.get(
        `https://localhost:${port}/callback?code=default-https-code`,
        { rejectUnauthorized: false },
        () => resolve(),
      );
      req.on("error", reject);
    });

    const authResult = await promise;
    expect(authResult.code).toBe("default-https-code");
    cleanup = authResult.cleanup;
  });
});
