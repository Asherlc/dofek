import { eightARow } from "../climbing-file-test-helpers.ts";

/** Sanitized outdoor shape observed from the shared API on 2026-11-01. */
export function eightANativeRow(values: Record<string, unknown> = {}) {
  return {
    ascentId: 123,
    platform: "eight_a",
    date: "2026-09-01T12:00:00+00:00",
    difficulty: "7A",
    zlaggableName: "A boulder",
    cragName: "Example Forest",
    sectorName: "Unknown Sector",
    countryName: "France",
    areaName: null,
    type: "rp",
    subType: null,
    tries: 0,
    comment: "",
    project: false,
    repeat: false,
    duplicate: false,
    rating: 0,
    recommended: false,
    ...values,
  };
}

export function eightAMatchingCsv(values: Record<string, string> = {}) {
  return eightARow({
    project: "0",
    rating: "0",
    recommended: "0",
    sub_type: "",
    sector_name: "Unknown Sector",
    ...values,
  });
}
