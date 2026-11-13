import { describe, expect, it } from "vitest";
import { encodeActivityRefreshScope } from "./activity-refresh-scope.ts";

describe("encodeActivityRefreshScope", () => {
  it("packs UUIDs in network order, preserving order, leading zeros and high bits", () => {
    const ids = ["00010203-0405-0607-0809-0a0b0c0d0e0f", "FFEEDDCC-BBAA-9988-7766-554433221100"];
    const encoded = encodeActivityRefreshScope(ids);
    expect(encoded).toBe("AAECAwQFBgcICQoLDA0OD//u3cy7qpmId2ZVRDMiEQA=");
    expect(Buffer.from(encoded, "base64").toString("hex")).toBe(
      "000102030405060708090a0b0c0d0e0fffeeddccbbaa99887766554433221100",
    );
    expect(encodeActivityRefreshScope(ids.map((id) => id.toLowerCase()))).toBe(encoded);
  });

  it.each([
    "",
    "00010203-0405-0607-0809-0a0b0c0d0e0",
    "00010203-0405-0607-0809-0a0b0c0d0e0g",
    "000102030405060708090a0b0c0d0e0f",
    " 00010203-0405-0607-0809-0a0b0c0d0e0f",
    "00010203-0405-0607-0809-0a0b0c0d0e0f\n",
  ])("rejects malformed UUID %j before hexadecimal conversion", (id) => {
    expect(() => encodeActivityRefreshScope([id])).toThrow("valid UUID");
  });

  it("rejects an empty ordinary scope", () => {
    expect(() => encodeActivityRefreshScope([])).toThrow("1 to 10000");
  });

  it("round trips all 10000 IDs without dropping duplicates or reordering", () => {
    const ids = Array.from(
      { length: 10000 },
      (_, index) => `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`,
    );
    const payload = encodeActivityRefreshScope(ids);
    expect(payload).toHaveLength(213336);
    const bytes = Buffer.from(payload, "base64");
    expect(bytes).toHaveLength(160000);
    for (const [index, id] of ids.entries()) {
      expect(bytes.subarray(index * 16, index * 16 + 16).toString("hex")).toBe(
        id.replaceAll("-", ""),
      );
    }
    expect(
      encodeActivityRefreshScope([
        "00000000-0000-0000-0000-000000000000",
        "00000000-0000-0000-0000-000000000000",
      ]),
    ).toBe(Buffer.alloc(32).toString("base64"));
  });

  it("rejects 10001 IDs", () => {
    expect(() =>
      encodeActivityRefreshScope(Array(10001).fill("00000000-0000-0000-0000-000000000000")),
    ).toThrow("1 to 10000");
  });
});
