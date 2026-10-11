/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClimbingEntrySources } from "./ClimbingEntrySources.tsx";

describe("ClimbingEntrySources", () => {
  it("links the name and every additional route and tick list with distinct labels", () => {
    render(
      <ClimbingEntrySources
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
    expect(screen.getByText("Mountain Project, OpenBeta")).toBeTruthy();
  });
  it("keeps an entry without verified destinations readable", () => {
    render(<ClimbingEntrySources name="Imported route" sourceName="Kaya" links={[]} />);
    expect(screen.getByText("Imported route")).toBeTruthy();
    expect(screen.getByText("Kaya")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
