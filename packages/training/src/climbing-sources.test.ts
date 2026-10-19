import { describe, expect, it } from "vitest";
import type { ClimbingSourceLink } from "./climbing-context.ts";
import { selectClimbingSources } from "./climbing-sources.ts";

const providerLabels: Record<string, string> = {
  mountain_project: "Mountain Project",
  openbeta: "OpenBeta",
};

function providerLabel(providerId: string): string {
  return providerLabels[providerId] ?? providerId;
}

describe("selectClimbingSources", () => {
  it("preserves route order and matches normalized, deduplicated attribution to ticks", () => {
    const openBetaTicks: ClimbingSourceLink = {
      providerId: "openbeta",
      kind: "ticks",
      url: "https://openbeta.io/u/climber/ticks",
    };
    const mountainProjectRoute: ClimbingSourceLink = {
      providerId: "mountain_project",
      kind: "route",
      url: "https://www.mountainproject.com/route/123/climb",
    };
    const mountainProjectTicks: ClimbingSourceLink = {
      providerId: "mountain_project",
      kind: "ticks",
      url: "https://www.mountainproject.com/user/456/ticks/ticks",
    };
    const openBetaRoute: ClimbingSourceLink = {
      providerId: "openbeta",
      kind: "route",
      url: "https://openbeta.io/climbs/abc",
    };

    expect(
      selectClimbingSources(
        " Mountain Project, , Imported log, Mountain Project ",
        [openBetaTicks, mountainProjectRoute, mountainProjectTicks, openBetaRoute],
        providerLabel,
      ),
    ).toEqual({
      primaryRoute: mountainProjectRoute,
      additionalRoutes: [openBetaRoute],
      sources: [
        { label: "Mountain Project", tickSource: mountainProjectTicks },
        { label: "Imported log", tickSource: undefined },
        { label: "OpenBeta", tickSource: openBetaTicks },
      ],
    });
  });

  it.each([null, ""])(
    "infers attribution from tick links when source names are %s",
    (sourceName) => {
      const tick: ClimbingSourceLink = {
        providerId: "openbeta",
        kind: "ticks",
        url: "https://openbeta.io/u/climber/ticks",
      };

      expect(selectClimbingSources(sourceName, [tick], providerLabel)).toEqual({
        primaryRoute: undefined,
        additionalRoutes: [],
        sources: [{ label: "OpenBeta", tickSource: tick }],
      });
    },
  );

  it("keeps route-only providers as unlinked attribution", () => {
    const route: ClimbingSourceLink = {
      providerId: "mountain_project",
      kind: "route",
      url: "https://www.mountainproject.com/route/123/climb",
    };

    expect(selectClimbingSources(null, [route], providerLabel)).toEqual({
      primaryRoute: route,
      additionalRoutes: [],
      sources: [{ label: "Mountain Project", tickSource: undefined }],
    });
  });

  it("selects the first matching tick destination for a provider", () => {
    const firstTick: ClimbingSourceLink = {
      providerId: "openbeta",
      kind: "ticks",
      url: "https://openbeta.io/u/first/ticks",
    };
    const secondTick: ClimbingSourceLink = {
      ...firstTick,
      url: "https://openbeta.io/u/second/ticks",
    };

    expect(selectClimbingSources(null, [firstTick, secondTick], providerLabel).sources).toEqual([
      { label: "OpenBeta", tickSource: firstTick },
    ]);
  });

  it("preserves recorded attribution without links and ignores empty labels", () => {
    expect(selectClimbingSources(" , Imported log, , ", [], providerLabel)).toEqual({
      primaryRoute: undefined,
      additionalRoutes: [],
      sources: [{ label: "Imported log", tickSource: undefined }],
    });
    expect(selectClimbingSources(null, [], providerLabel)).toEqual({
      primaryRoute: undefined,
      additionalRoutes: [],
      sources: [],
    });
  });
});
