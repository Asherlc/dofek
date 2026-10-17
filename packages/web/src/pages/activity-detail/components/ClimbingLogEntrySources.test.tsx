/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClimbingLogEntrySources } from "./ClimbingLogEntrySources.tsx";

describe("ClimbingLogEntrySources", () => {
  it.each(["Mountain Project, OpenBeta", "OpenBeta"])(
    "links distinct source destinations with attribution %s",
    (sourceName) => {
      render(
        <ClimbingLogEntrySources
          name="Swiss Cheese"
          sourceName={sourceName}
          links={[
            {
              providerId: "mountain-project",
              kind: "route",
              url: "https://www.mountainproject.com/route/105734732/swiss-cheese",
            },
            {
              providerId: "openbeta",
              kind: "route",
              url: "https://openbeta.io/climb/10000000-0000-4000-8000-000000000001",
            },
            { providerId: "openbeta", kind: "ticks", url: "https://openbeta.io/u/thickles/ticks" },
          ]}
        />,
      );
      expect(
        screen.getByRole("link", { name: "Swiss Cheese on Mountain Project" }).getAttribute("href"),
      ).toBe("https://www.mountainproject.com/route/105734732/swiss-cheese");
      expect(
        screen.getByRole("link", { name: "Swiss Cheese route on OpenBeta" }).getAttribute("href"),
      ).toContain("openbeta.io/climb/");
      expect(screen.getByRole("link", { name: "OpenBeta ticks" }).getAttribute("href")).toBe(
        "https://openbeta.io/u/thickles/ticks",
      );
      expect(screen.getByRole("link", { name: "Swiss Cheese route on OpenBeta" }).textContent).toBe(
        "OpenBeta route",
      );
      expect(screen.getByRole("link", { name: "OpenBeta ticks" }).textContent).toBe(
        "OpenBeta ticks",
      );
      expect(screen.getByText(sourceName)).toBeTruthy();
    },
  );
  it("uses concise destination labels when the attribution identifies their provider", () => {
    render(
      <ClimbingLogEntrySources
        name="Road Kill"
        sourceName="OpenBeta"
        links={[
          { providerId: "openbeta", kind: "route", url: "https://openbeta.io/climb/road-kill" },
          { providerId: "openbeta", kind: "ticks", url: "https://openbeta.io/u/thickles/ticks" },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "Road Kill on OpenBeta" })).toHaveTextContent(
      "Road Kill",
    );
    expect(screen.getByRole("link", { name: "OpenBeta ticks" })).toHaveTextContent(/^Ticks$/);
    expect(screen.getByText("OpenBeta")).toBeTruthy();
  });
  it("identifies linked destinations when no source attribution is available", () => {
    render(
      <ClimbingLogEntrySources
        name="Road Kill"
        sourceName={null}
        links={[
          { providerId: "openbeta", kind: "ticks", url: "https://openbeta.io/u/thickles/ticks" },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "OpenBeta ticks" })).toHaveTextContent(
      "OpenBeta ticks",
    );
  });
  it("names the linked provider when it differs from the source attribution", () => {
    render(
      <ClimbingLogEntrySources
        name="Road Kill"
        sourceName="Kaya"
        links={[
          { providerId: "openbeta", kind: "route", url: "https://openbeta.io/climb/road-kill" },
          { providerId: "openbeta", kind: "ticks", url: "https://openbeta.io/u/thickles/ticks" },
        ]}
      />,
    );
    expect(screen.getByText("Kaya")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Road Kill on OpenBeta" })).toHaveAttribute(
      "href",
      "https://openbeta.io/climb/road-kill",
    );
    expect(screen.getByRole("link", { name: "OpenBeta ticks" })).toHaveTextContent(
      /^OpenBeta ticks$/,
    );
  });
  it("keeps an entry without verified destinations readable", () => {
    render(<ClimbingLogEntrySources name="Imported route" sourceName="Kaya" links={[]} />);
    expect(screen.getByText("Imported route")).toBeTruthy();
    expect(screen.getByText("Kaya")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
