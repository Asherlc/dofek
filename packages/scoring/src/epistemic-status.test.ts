import {
  EPISTEMIC_STATUS,
  EPISTEMIC_STATUS_KINDS,
  getEpistemicStatus,
} from "./epistemic-status.ts";

describe("epistemic status vocabulary", () => {
  it("exposes the complete shared vocabulary with exact display labels", () => {
    expect(EPISTEMIC_STATUS_KINDS).toEqual([
      "observed",
      "estimated",
      "associated",
      "suggested",
      "unavailable",
    ]);
    expect(EPISTEMIC_STATUS).toEqual({
      observed: { kind: "observed", label: "Observed" },
      estimated: { kind: "estimated", label: "Estimated" },
      associated: { kind: "associated", label: "Associated" },
      suggested: { kind: "suggested", label: "Suggested" },
      unavailable: { kind: "unavailable", label: "Unavailable" },
    });
  });

  it("returns the server-owned status descriptor for a kind", () => {
    expect(getEpistemicStatus("estimated")).toEqual({ kind: "estimated", label: "Estimated" });
  });
});
