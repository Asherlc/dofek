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

it("ranks by pixel area with missing dimensions and leaves the input intact", () => {
  const variants = [
    { url: "unknown", width: null, height: null },
    { url: "wide", width: 1000, height: 1 },
    { url: "square", width: 100, height: 100 },
    { url: "missingHeight", width: 20000, height: null },
    { url: "missingWidth", width: null, height: 20000 },
  ];
  expect(selectImageVariant(variants).url).toBe("square");
  expect(variants[0]?.url).toBe("unknown");
});
it("normalizes all signing keys and semantic parameter ordering", () => {
  const base = "https://cdn.test/image?a=1&b=2";
  expect(
    sourceImageIdentity(
      base +
        "&X-Amz-Signature=old&X-Goog-Credential=old&Signature=s&Expires=3&Token=t&Policy=p&Key-Pair-Id=k",
    ),
  ).toBe(sourceImageIdentity("https://cdn.test/image?b=2&a=1"));
  expect(sourceImageIdentity(`${base}&mytoken=semantic`)).not.toBe(sourceImageIdentity(base));
});
