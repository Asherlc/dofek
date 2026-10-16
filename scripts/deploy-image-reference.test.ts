import { describe, expect, it } from "vitest";
import { imageRepository, immutableImageReference } from "./deploy-image-reference.ts";

const digest = `sha256:${"a".repeat(64)}`;
describe("deployment image references", () => {
  it("compares tagged and untagged digest references by repository and manifest identity", () => {
    expect(immutableImageReference(`ghcr.io/owner/app:old@${digest}`)).toBe(
      `ghcr.io/owner/app@${digest}`,
    );
    expect(immutableImageReference(`ghcr.io/owner/app@${digest}`)).toBe(
      `ghcr.io/owner/app@${digest}`,
    );
  });
  it("preserves registry ports when stripping tags", () => {
    expect(imageRepository("127.0.0.1:54321/app:old")).toBe("127.0.0.1:54321/app");
    expect(immutableImageReference(`127.0.0.1:54321/app:old@${digest}`)).toBe(
      `127.0.0.1:54321/app@${digest}`,
    );
  });
  it.each([
    "app:tag",
    "app@sha256:bad",
    `app@${digest}@${digest}`,
    `app@${digest}\ninjected=value`,
  ])("rejects non-immutable or malformed reference %s", (image) => {
    expect(() => immutableImageReference(image)).toThrow();
  });
});
