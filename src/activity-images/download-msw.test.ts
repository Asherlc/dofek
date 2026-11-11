import { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { expect, it } from "vitest";
import { downloadActivityImage } from "./download.ts";

it("downloads a public HTTPS image through the real request and temporary-file lifecycle", async () => {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=",
    "base64",
  );
  const server = setupServer(
    http.get(
      "https://8.8.8.8/photo",
      () => new HttpResponse(new Uint8Array(bytes), { headers: { "content-type": "image/png" } }),
    ),
  );
  server.listen({ onUnhandledFrame: "error" });
  syncBuiltinESMExports();
  try {
    const image = await downloadActivityImage({
      url: "https://8.8.8.8/photo",
      allowedOrigins: ["https://8.8.8.8"],
    });
    try {
      expect(await readFile(image.filePath)).toEqual(bytes);
      expect(image).toMatchObject({ width: 1, height: 1, sizeBytes: bytes.length });
    } finally {
      await image.cleanup();
    }
    await expect(readFile(image.filePath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    server.close();
    syncBuiltinESMExports();
  }
});
