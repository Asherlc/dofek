/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClimbingLogEntrySources } from "./ClimbingLogEntrySources.tsx";

describe("ClimbingLogEntrySources", () => {
  it("links the name and every additional route and tick list with distinct labels", () => {
    render(
      <ClimbingLogEntrySources
        name="Swiss Cheese"
        sourceName="Mountain Project, OpenBeta"
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
    expect(screen.getByRole("link", { name: "OpenBeta ticks" }).textContent).toBe("OpenBeta ticks");
    expect(screen.getByText("Mountain Project, OpenBeta")).toBeTruthy();
  });
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
  it("keeps an entry without verified destinations readable", () => {
    render(<ClimbingLogEntrySources name="Imported route" sourceName="Kaya" links={[]} />);
    expect(screen.getByText("Imported route")).toBeTruthy();
    expect(screen.getByText("Kaya")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
