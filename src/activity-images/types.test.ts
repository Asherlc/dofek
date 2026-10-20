import { describe, expect, it } from "vitest";
import { selectImageVariant, sourceImageIdentity } from "./types.ts";

describe("provider image identity and variants", () => {
  it("selects the largest original without dropping distinct source identities", () => {
    expect(
      selectImageVariant([
        { url: "https://cdn.test/small", width: 100, height: 50 },
        { url: "https://cdn.test/large", width: 1200, height: 600 },
      ]).url,
    ).toBe("https://cdn.test/large");
  });
  it("does not mistake signed query rotation for a new logical source", () => {
    expect(sourceImageIdentity("https://cdn.test/image.png?signature=old")).toBe(
      sourceImageIdentity("https://cdn.test/image.png?signature=new"),
    );
  });
  it("retains paths and rejects an empty candidate", () => {
    expect(sourceImageIdentity("https://cdn.test/a")).not.toBe(
      sourceImageIdentity("https://cdn.test/b"),
    );
    expect(() => selectImageVariant([])).toThrow("No image variants");
  });
});

it("keeps semantic query parameters in fallback image identities", () => {
  expect(sourceImageIdentity("https://cdn.test/image?id=one&signature=old")).not.toBe(
    sourceImageIdentity("https://cdn.test/image?id=two&signature=new"),
  );
});
