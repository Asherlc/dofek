import nodeHttp from "node:http";
import { Socket } from "node:net";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderArtifactStorageTestContext } from "../test-helpers.ts";
import { createIntegrationMswFixture, startEarlyMsw } from "./early-msw-lifecycle.ts";
import { failOnUnhandledExternalRequest } from "./msw.ts";

describe("early MSW lifecycle", () => {
  const originalFetch = globalThis.fetch;
  const originalRequest = nodeHttp.request;
  const nativeFetch = vi.fn<typeof fetch>(
    async () => new Response("native sentinel", { status: 401 }),
  );
  let stop: () => void;

  beforeEach(() => {
    nativeFetch.mockClear();
    globalThis.fetch = nativeFetch;
    vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
      throw new Error("Unexpected socket");
    });
    stop = startEarlyMsw();
  });

  afterEach(() => {
    stop();
    expect(globalThis.fetch).toBe(nativeFetch);
    expect(nodeHttp.request).toBe(originalRequest);
    expect(Socket.prototype.connect).not.toHaveBeenCalled();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("dispatches retained fetch to each current handler exactly once", async () => {
    const retainedFetch = globalThis.fetch;
    const handled = vi.fn(() => HttpResponse.text("handled"));
    const fixture = createIntegrationMswFixture(
      http.get("https://fixture.example.test/handled", handled),
    );
    const warnings = vi.spyOn(console, "warn");
    expect(await (await retainedFetch("https://fixture.example.test/unhandled")).text()).toBe(
      "native sentinel",
    );
    fixture.activate({ onUnhandledRequest: "bypass" });
    expect(await (await retainedFetch("https://fixture.example.test/handled")).text()).toBe(
      "handled",
    );
    expect(handled).toHaveBeenCalledTimes(1);
    expect(await (await retainedFetch("https://fixture.example.test/unhandled")).text()).toBe(
      "native sentinel",
    );
    expect(nativeFetch).toHaveBeenCalledTimes(2);
    expect(warnings).not.toHaveBeenCalled();
    fixture.deactivate();
  });

  it("restores fetch and HTTP independently with only bootstrap and can reopen", async () => {
    const retainedFetch = globalThis.fetch;
    expect(globalThis.fetch).not.toBe(nativeFetch);
    expect(nodeHttp.request).not.toBe(originalRequest);
    stop();
    expect(globalThis.fetch).toBe(nativeFetch);
    expect(nodeHttp.request).toBe(originalRequest);
    stop();
    stop = startEarlyMsw();
    const handled = vi.fn(() => HttpResponse.text("reopened"));
    const fixture = createIntegrationMswFixture(
      http.get("https://fixture.example.test/reopened", handled),
    );
    fixture.activate({ onUnhandledRequest: "error" });
    expect(await (await retainedFetch("https://fixture.example.test/reopened")).text()).toBe(
      "reopened",
    );
    expect(handled).toHaveBeenCalledTimes(1);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("restores constructor baselines after runtime overrides and isolates suite transitions", async () => {
    const baseline = vi.fn(() => HttpResponse.text("baseline"));
    const override = vi.fn(() => HttpResponse.text("override"));
    const fixture = createIntegrationMswFixture(
      http.get("https://fixture.example.test/baseline", baseline),
    );
    fixture.activate({ onUnhandledRequest: "error" });
    fixture.use(http.get("https://fixture.example.test/baseline", override));
    expect(await (await fetch("https://fixture.example.test/baseline")).text()).toBe("override");
    fixture.resetHandlers();
    expect(await (await fetch("https://fixture.example.test/baseline")).text()).toBe("baseline");
    expect(override).toHaveBeenCalledTimes(1);
    expect(baseline).toHaveBeenCalledTimes(1);
    fixture.deactivate();
    const next = createIntegrationMswFixture();
    next.activate({ onUnhandledRequest: "bypass" });
    expect(await (await fetch("https://fixture.example.test/baseline")).text()).toBe(
      "native sentinel",
    );
    expect(baseline).toHaveBeenCalledTimes(1);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it("preserves external-only, strict, bypass, and localhost-only policies", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const fixture = createIntegrationMswFixture();
    fixture.activate({ onUnhandledRequest: failOnUnhandledExternalRequest });
    await expect(fetch("https://unexpected.example.test/")).rejects.toThrow();
    expect((await fetch("http://localhost/allowed")).status).toBe(401);
    expect((await fetch("http://127.0.0.1/allowed")).status).toBe(401);
    fixture.activate({ onUnhandledRequest: "error" });
    await expect(fetch("http://localhost/strict")).rejects.toThrow();
    fixture.activate({ onUnhandledRequest: "bypass" });
    expect((await fetch("https://unexpected.example.test/bypass")).status).toBe(401);
    fixture.activate({
      onUnhandledRequest(request) {
        if (new URL(request.url).hostname === "localhost") return;
        throw new Error(`Unhandled external request: ${request.url}`);
      },
    });
    expect((await fetch("http://localhost/support")).status).toBe(401);
    const localRejected = await fetch("http://127.0.0.1/support");
    expect(localRejected.status).toBe(500);
    expect(await localRejected.text()).toContain("Unhandled external request");
    const externalRejected = await fetch("https://unexpected.example.test/support");
    expect(externalRejected.status).toBe(500);
    expect(await externalRejected.text()).toContain("Unhandled external request");
    expect(nativeFetch).toHaveBeenCalledTimes(4);
    expect(errors).toHaveBeenCalledTimes(2);
    fixture.deactivate();
    expect((await fetch("https://unexpected.example.test/default")).status).toBe(401);
    expect(nativeFetch).toHaveBeenCalledTimes(5);
  });

  it("retains artifact HEAD, PUT, and GET baselines and S3 data across handler resets", async () => {
    const archive = createProviderArtifactStorageTestContext("https://archive.example.test");
    archive.server.activate({ onUnhandledRequest: "error" });
    const object = { Bucket: "imports", Key: "fixture.fit" };
    try {
      await archive.client.send(
        new PutObjectCommand({ ...object, Body: Buffer.from("fit bytes") }),
      );
      expect(archive.writes).toEqual(["fixture.fit"]);
      expect(archive.originals.get("fixture.fit")).toEqual(Buffer.from("fit bytes"));
      archive.server.use(
        http.head(
          "https://archive.example.test/imports/*",
          () => new HttpResponse(null, { status: 404 }),
        ),
      );
      await expect(archive.client.send(new HeadObjectCommand(object))).rejects.toMatchObject({
        $metadata: { httpStatusCode: 404 },
      });
      archive.server.resetHandlers();
      expect((await archive.client.send(new HeadObjectCommand(object))).ContentLength).toBe(9);
      const stored = await archive.client.send(new GetObjectCommand(object));
      expect(await stored.Body?.transformToString()).toBe("fit bytes");
      expect(archive.writes).toEqual(["fixture.fit"]);
      expect(nativeFetch).not.toHaveBeenCalled();
    } finally {
      archive.server.deactivate();
      archive.client.destroy();
    }
  });
});
