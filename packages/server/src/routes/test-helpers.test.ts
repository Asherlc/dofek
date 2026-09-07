import express from "express";
import { describe, expect, it } from "vitest";
import { getJsonResponseInProcess, postJsonInProcess } from "./test-helpers.ts";

describe("in-process JSON request helpers", () => {
  it("rejects a top-level value that JSON cannot serialize", async () => {
    await expect(postJsonInProcess(express(), "/test", undefined)).rejects.toThrow(
      "requires a JSON-serializable body",
    );
  });

  it("exposes response headers when a test needs the complete response", async () => {
    const app = express();
    app.get("/test", (_request, response) => {
      response.set("Cache-Control", "no-store").status(200).json({ ok: true });
    });

    await expect(getJsonResponseInProcess(app, "/test")).resolves.toMatchObject({
      status: 200,
      body: { ok: true },
      headers: { "cache-control": "no-store" },
    });
  });
});
