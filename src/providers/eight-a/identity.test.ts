import { describe, expect, it } from "vitest";
import { eightAHeader } from "../climbing-file-test-helpers.ts";
import { parseEightAAscentPage } from "./ascent.ts";
import { resolveEightAIdentities } from "./identity.ts";
import { parseEightAExport } from "./parser.ts";
import { eightAMatchingCsv, eightANativeRow } from "./test-helpers.ts";

const csv = parseEightAExport(`${eightAHeader}\n${eightAMatchingCsv()}`);
const native = parseEightAAscentPage(
  { ascents: [eightANativeRow()], pageIndex: 0, totalItems: 1 },
  "bouldering",
  0,
);
const knownCsv = csv.map((entry) => ({
  id: "csv-id",
  externalId: entry.externalId,
  raw: entry.raw,
}));
const knownNative = native.map((entry) => ({
  id: "native-id",
  externalId: entry.externalId,
  raw: entry.raw,
}));

describe("Vertical-Life strict source identity", () => {
  it("binds a unique exact legacy CSV occurrence to its native identity and preserves both payloads", () => {
    const resolved = resolveEightAIdentities(native, knownCsv, "native", true);
    expect(resolved.migrations).toEqual([{ id: "csv-id", externalId: native[0]?.externalId }]);
    expect(resolved.entries[0]?.raw).toEqual({ native: native[0]?.raw, csv: csv[0]?.raw });
  });
  it("validates a connected upload without replacing richer native facts", () => {
    const resolved = resolveEightAIdentities(csv, knownNative, "csv", true);
    expect(resolved.entries).toEqual([]);
    expect(resolved.rawUpdates).toEqual([
      { id: "native-id", raw: { native: native[0]?.raw, csv: csv[0]?.raw } },
    ]);
  });
  it("preserves ordinary idempotent uploads before any connection", () => {
    expect(resolveEightAIdentities(csv, knownCsv, "csv", false).entries).toEqual(csv);
  });
  it.each(["comment", "name", "date", "difficulty"])(
    "rejects an edited or unmatched connected CSV %s",
    (field) => {
      const rows = parseEightAExport(
        `${eightAHeader}\n${eightAMatchingCsv({ [field]: field === "date" ? "2026-09-02" : "changed" })}`,
      );
      expect(() => resolveEightAIdentities(rows, knownNative, "csv", true)).toThrow(
        /unique exact match/i,
      );
    },
  );
  it("rejects unmatched legacy CSV history before a native transition", () => {
    expect(() => resolveEightAIdentities([], knownCsv, "native", true)).toThrow(/existing CSV/i);
  });
  it("rejects either direction of ambiguous duplicates", () => {
    const repeated = parseEightAAscentPage(
      {
        ascents: [eightANativeRow(), eightANativeRow({ ascentId: 124, repeat: true })],
        pageIndex: 0,
        totalItems: 2,
      },
      "bouldering",
      0,
    );
    expect(() => resolveEightAIdentities(repeated, knownCsv, "native", true)).toThrow(
      /unique exact match/i,
    );
    expect(() =>
      resolveEightAIdentities(
        csv,
        [
          ...knownNative,
          {
            ...knownNative[0],
            raw: knownNative[0]?.raw,
            id: "other",
            externalId: repeated[1]?.externalId ?? null,
          },
        ],
        "csv",
        true,
      ),
    ).toThrow(/unique exact match/i);
    expect(() =>
      resolveEightAIdentities(
        native,
        [
          ...knownCsv,
          { ...knownCsv[0], raw: knownCsv[0]?.raw, id: "other", externalId: "csv-other" },
        ],
        "native",
        true,
      ),
    ).toThrow(/unique exact match/i);
  });
  it("keeps prior CSV provenance after native edits and accepts the original upload without reverting them", () => {
    const original = resolveEightAIdentities(native, knownCsv, "native", true).entries[0];
    if (!original) throw new Error("Expected matched native entry");
    const edited = parseEightAAscentPage(
      { ascents: [eightANativeRow({ comment: "new native note" })], pageIndex: 0, totalItems: 1 },
      "bouldering",
      0,
    );
    const updated = resolveEightAIdentities(
      edited,
      [{ id: "csv-id", externalId: original.externalId, raw: original.raw }],
      "native",
      true,
    ).entries[0];
    expect(updated?.raw).toEqual({ native: edited[0]?.raw, csv: csv[0]?.raw });
    const uploaded = resolveEightAIdentities(
      csv,
      [{ id: "csv-id", externalId: original.externalId, raw: updated?.raw }],
      "csv",
      true,
    );
    expect(uploaded.entries).toEqual([]);
    expect(uploaded.rawUpdates[0]?.raw).toEqual(updated?.raw);
  });
});
