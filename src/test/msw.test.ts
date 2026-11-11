import { once } from "node:events";
import { createServer, get } from "node:http";
import { setupServer } from "msw/node";
import { describe, expect, it, vi } from "vitest";
import { failOnUnhandledExternalRequest } from "./msw.ts";

describe("failOnUnhandledExternalRequest", () => {
  it("enforces a new strict policy on a retained client after reopening", async () => {
    const listener = createServer((_request, response) => response.end("native"));
    let dispatched = 0;
    listener.on("request", () => dispatched++);
    listener.listen(0);
    await once(listener, "listening");
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Missing listener address");
    const server = setupServer();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const url = `http://localhost.:${address.port}/`;
    try {
      server.listen({ onUnhandledFrame: "bypass" });
      expect(await (await fetch(url)).text()).toBe("native");
      server.close();
      server.listen({ onUnhandledFrame: failOnUnhandledExternalRequest });
      await expect(fetch(url)).rejects.toThrow();
      expect(dispatched).toBe(1);
    } finally {
      server.close();
      errors.mockRestore();
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it("allows local requests and rejects external requests before dispatch", async () => {
    const listener = createServer((_request, response) => response.end("native"));
    let dispatched = 0;
    listener.on("request", () => dispatched++);
    listener.listen(0);
    await once(listener, "listening");
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Missing listener address");
    const server = setupServer();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await new Promise<void>((resolve, reject) => {
      get(`http://localhost.:${address.port}/`, { agent: false }, (response) => {
        response.resume();
        response.on("end", resolve);
      }).on("error", reject);
    });
    server.listen({ onUnhandledFrame: failOnUnhandledExternalRequest });
    try {
      expect(await (await fetch(`http://localhost:${address.port}/`)).text()).toBe("native");
      expect(await (await fetch(`http://127.0.0.1:${address.port}/`)).text()).toBe("native");
      await expect(fetch(`http://localhost.:${address.port}/`)).rejects.toThrow();
      expect(dispatched).toBe(3);
    } finally {
      server.close();
      errors.mockRestore();
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
