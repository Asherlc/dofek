import { once } from "node:events";
import nodeHttp from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { HttpResponse, http } from "msw";
import { HttpNetworkFrame } from "msw/experimental";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderArtifactStorageTestContext } from "../test-helpers.ts";
import { createIntegrationMswFixture, startEarlyMsw } from "./early-msw-lifecycle.ts";
import { failOnUnhandledExternalRequest } from "./msw.ts";

it("passes through non-HTTP TCP while the early interceptor is active", async () => {
  const listener = createTcpServer((socket) => socket.end("tcp sentinel"));
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing listener address");
  const stop = startEarlyMsw();
  const fixture = createIntegrationMswFixture();
  fixture.activate({ onUnhandledFrame: "error" });
  try {
    const socket = connect(address.port, "127.0.0.1");
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      data += chunk;
    });
    await once(socket, "end");
    expect(data).toBe("tcp sentinel");
  } finally {
    stop();
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("reuses a native keep-alive connection while the early interceptor is active", async () => {
  const listener = nodeHttp.createServer((_request, response) => response.end("ok"));
  let connections = 0;
  listener.on("connection", () => connections++);
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing listener address");
  const agent = new nodeHttp.Agent({ keepAlive: true, maxSockets: 1 });
  const stop = startEarlyMsw();
  try {
    for (let i = 0; i < 3; i++) {
      await new Promise<void>((resolve, reject) => {
        nodeHttp
          .get({ host: "127.0.0.1", port: address.port, agent }, (response) => {
            response.resume();
            response.on("end", resolve);
          })
          .on("error", reject);
      });
    }
    expect(connections).toBe(1);
  } finally {
    stop();
    agent.destroy();
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

describe("early MSW lifecycle", () => {
  const originalFetch = globalThis.fetch;
  const originalRequest = nodeHttp.request;
  let listener: nodeHttp.Server;
  let base: string;
  let nativeCalls: number;
  let stop: () => void;

  beforeEach(async () => {
    nativeCalls = 0;
    listener = nodeHttp.createServer((_request, response) => {
      nativeCalls++;
      response.writeHead(401);
      response.end("native sentinel");
    });
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Missing listener address");
    base = `http://127.0.0.1:${address.port}`;
    stop = startEarlyMsw();
  });

  afterEach(async () => {
    stop();
    expect(globalThis.fetch).toBe(originalFetch);
    expect(nodeHttp.request).toBe(originalRequest);
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    vi.restoreAllMocks();
  });

  it("dispatches retained fetch to each current handler exactly once", async () => {
    const retainedFetch = globalThis.fetch;
    const handled = vi.fn(() => HttpResponse.text("handled"));
    const fixture = createIntegrationMswFixture(http.get(`${base}/handled`, handled));
    const warnings = vi.spyOn(console, "warn");
    expect(await (await retainedFetch(`${base}/unhandled`)).text()).toBe("native sentinel");
    fixture.activate({ onUnhandledFrame: "bypass" });
    expect(await (await retainedFetch(`${base}/handled`)).text()).toBe("handled");
    expect(handled).toHaveBeenCalledTimes(1);
    expect(await (await retainedFetch(`${base}/unhandled`)).text()).toBe("native sentinel");
    expect(nativeCalls).toBe(2);
    expect(warnings).not.toHaveBeenCalled();
    fixture.deactivate();
  });

  it("restores fetch and HTTP independently with only bootstrap and can reopen", async () => {
    const retainedFetch = globalThis.fetch;
    expect(globalThis.fetch).not.toBe(originalFetch);
    stop();
    expect(globalThis.fetch).toBe(originalFetch);
    expect(nodeHttp.request).toBe(originalRequest);
    stop();
    stop = startEarlyMsw();
    const handled = vi.fn(() => HttpResponse.text("reopened"));
    const fixture = createIntegrationMswFixture(http.get(`${base}/reopened`, handled));
    fixture.activate({ onUnhandledFrame: "error" });
    expect(await (await retainedFetch(`${base}/reopened`)).text()).toBe("reopened");
    expect(handled).toHaveBeenCalledTimes(1);
    expect(nativeCalls).toBe(0);
  });

  it("restores constructor baselines after runtime overrides and isolates suite transitions", async () => {
    const baseline = vi.fn(() => HttpResponse.text("baseline"));
    const override = vi.fn(() => HttpResponse.text("override"));
    const fixture = createIntegrationMswFixture(http.get(`${base}/baseline`, baseline));
    fixture.activate({ onUnhandledFrame: "error" });
    fixture.use(http.get(`${base}/baseline`, override));
    expect(await (await fetch(`${base}/baseline`)).text()).toBe("override");
    fixture.resetHandlers();
    expect(await (await fetch(`${base}/baseline`)).text()).toBe("baseline");
    expect(override).toHaveBeenCalledTimes(1);
    expect(baseline).toHaveBeenCalledTimes(1);
    fixture.deactivate();
    const next = createIntegrationMswFixture();
    next.activate({ onUnhandledFrame: "bypass" });
    expect(await (await fetch(`${base}/baseline`)).text()).toBe("native sentinel");
    expect(baseline).toHaveBeenCalledTimes(1);
    expect(nativeCalls).toBe(1);
  });

  it("preserves external-only, strict, bypass, and custom policies", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fixture = createIntegrationMswFixture();
    fixture.activate({ onUnhandledFrame: failOnUnhandledExternalRequest });
    await expect(fetch("https://unexpected.example.test/")).rejects.toThrow();
    expect((await fetch(`${base}/allowed`)).status).toBe(401);
    fixture.activate({ onUnhandledFrame: "error" });
    await expect(fetch(`${base}/strict`)).rejects.toThrow();
    expect(nativeCalls).toBe(1);
    fixture.activate({ onUnhandledFrame: "bypass" });
    expect((await fetch(`${base}/bypass`)).status).toBe(401);
    fixture.activate({
      onUnhandledFrame({ frame }) {
        if (!(frame instanceof HttpNetworkFrame)) throw Response.error();
        if (new URL(frame.data.request.url).hostname === "localhost") return;
        throw new Error(`Unhandled external request: ${frame.data.request.url}`);
      },
    });
    expect((await fetch(`${base.replace("127.0.0.1", "localhost")}/support`)).status).toBe(401);
    expect(nativeCalls).toBe(3);
    const localRejected = await fetch(`${base}/support`);
    expect(localRejected.status).toBe(500);
    expect(await localRejected.text()).toContain("Unhandled external request");
    const externalRejected = await fetch("https://unexpected.example.test/support");
    expect(externalRejected.status).toBe(500);
    expect(await externalRejected.text()).toContain("Unhandled external request");
    expect(nativeCalls).toBe(3);
    fixture.deactivate();
    expect((await fetch(`${base}/default`)).status).toBe(401);
    expect(nativeCalls).toBe(4);
  });

  it("retains artifact HEAD, PUT, and GET baselines and S3 data across handler resets", async () => {
    const archive = createProviderArtifactStorageTestContext(base);
    archive.server.activate({ onUnhandledFrame: "error" });
    const object = { Bucket: "imports", Key: "fixture.fit" };
    try {
      await archive.client.send(
        new PutObjectCommand({ ...object, Body: Buffer.from("fit bytes") }),
      );
      expect(archive.writes).toEqual(["fixture.fit"]);
      expect(archive.originals.get("fixture.fit")).toEqual(Buffer.from("fit bytes"));
      archive.server.use(
        http.head(`${base}/imports/*`, () => new HttpResponse(null, { status: 404 })),
      );
      await expect(archive.client.send(new HeadObjectCommand(object))).rejects.toMatchObject({
        $metadata: { httpStatusCode: 404 },
      });
      archive.server.resetHandlers();
      expect((await archive.client.send(new HeadObjectCommand(object))).ContentLength).toBe(9);
      const stored = await archive.client.send(new GetObjectCommand(object));
      expect(await stored.Body?.transformToString()).toBe("fit bytes");
      expect(archive.writes).toEqual(["fixture.fit"]);
      expect(nativeCalls).toBe(0);
    } finally {
      archive.server.deactivate();
      archive.client.destroy();
    }
  });
});
