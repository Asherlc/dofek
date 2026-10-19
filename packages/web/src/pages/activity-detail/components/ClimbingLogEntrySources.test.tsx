/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClimbingLogEntrySources } from "./ClimbingLogEntrySources.tsx";

describe("ClimbingLogEntrySources", () => {
  it.each(["Mountain Project, OpenBeta", "OpenBeta"])(
    "links each provider name to its tick history with attribution %s",
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
              providerId: "mountain-project",
              kind: "ticks",
              url: "https://www.mountainproject.com/user/110186720/ticks/ticks",
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
      expect(screen.getByRole("link", { name: "Mountain Project" })).toHaveAttribute(
        "href",
        "https://www.mountainproject.com/user/110186720/ticks/ticks",
      );
      expect(screen.getByRole("link", { name: "OpenBeta" })).toHaveAttribute(
        "href",
        "https://openbeta.io/u/thickles/ticks",
      );
    },
  );
  it("links the climb name to the route and provider name to tick history", () => {
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
    expect(screen.getByRole("link", { name: "OpenBeta" })).toHaveAttribute(
      "href",
      "https://openbeta.io/u/thickles/ticks",
    );
  });
  it("links the provider's tick history when no route is available", () => {
    render(
      <ClimbingLogEntrySources
        name="Road Kill"
        sourceName={null}
        links={[
          { providerId: "openbeta", kind: "ticks", url: "https://openbeta.io/u/thickles/ticks" },
        ]}
      />,
    );
    expect(screen.getByText("Road Kill")).toBeTruthy();
    expect(screen.getByText("OpenBeta")).toBeTruthy();
    expect(screen.getByRole("link", { name: "OpenBeta" })).toHaveAttribute(
      "href",
      "https://openbeta.io/u/thickles/ticks",
    );
  });
  it("preserves an unlinked source beside a different provider's tick history", () => {
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
    expect(screen.queryByRole("link", { name: "Kaya" })).toBeNull();
    expect(screen.getByRole("link", { name: "OpenBeta" })).toHaveAttribute(
      "href",
      "https://openbeta.io/u/thickles/ticks",
    );
  });
  it("keeps mixed attribution readable when one provider has no tick history", () => {
    render(
      <ClimbingLogEntrySources
        name="Swiss Cheese"
        sourceName="Mountain Project, Kaya"
        links={[
          {
            providerId: "mountain-project",
            kind: "route",
            url: "https://www.mountainproject.com/route/105734732/swiss-cheese",
          },
          {
            providerId: "mountain-project",
            kind: "ticks",
            url: "https://www.mountainproject.com/user/110186720/ticks/ticks",
          },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "Mountain Project" })).toHaveAttribute(
      "href",
      "https://www.mountainproject.com/user/110186720/ticks/ticks",
    );
    expect(screen.getByRole("paragraph")).toHaveTextContent("Mountain Project, Kaya");
    expect(screen.queryByRole("link", { name: "Kaya" })).toBeNull();
  });
  it("keeps an entry without verified destinations readable", () => {
    render(<ClimbingLogEntrySources name="Imported route" sourceName="Kaya" links={[]} />);
    expect(screen.getByText("Imported route")).toBeTruthy();
    expect(screen.getByText("Kaya")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("keeps the provider as text when only a route destination is known", () => {
    render(
      <ClimbingLogEntrySources
        name="Swiss Cheese"
        sourceName="Mountain Project"
        links={[
          {
            providerId: "mountain-project",
            kind: "route",
            url: "https://www.mountainproject.com/route/105734732/swiss-cheese",
          },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "Swiss Cheese on Mountain Project" })).toHaveAttribute(
      "href",
      "https://www.mountainproject.com/route/105734732/swiss-cheese",
    );
    expect(screen.getByText("Mountain Project")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Mountain Project" })).toBeNull();
  });
});
