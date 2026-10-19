import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Alert, Linking } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureException } from "../lib/telemetry";
import { ClimbingLogEntrySources } from "./ClimbingLogEntrySources";

vi.mock("../lib/telemetry", () => ({ captureException: vi.fn(), logger: { warn: vi.fn() } }));
const links = [
  {
    providerId: "mountain-project",
    kind: "route" as const,
    url: "https://www.mountainproject.com/route/105734732/swiss-cheese",
  },
  {
    providerId: "openbeta",
    kind: "route" as const,
    url: "https://openbeta.io/climb/10000000-0000-4000-8000-000000000001",
  },
  { providerId: "openbeta", kind: "ticks" as const, url: "https://openbeta.io/u/thickles/ticks" },
  {
    providerId: "mountain-project",
    kind: "ticks" as const,
    url: "https://www.mountainproject.com/user/110186720/ticks/ticks",
  },
];
describe("ClimbingLogEntrySources", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(["Mountain Project, OpenBeta", "OpenBeta"])(
    "opens each provider name's tick history with attribution %s",
    (sourceName) => {
      render(<ClimbingLogEntrySources name="Swiss Cheese" sourceName={sourceName} links={links} />);
      for (const label of ["Swiss Cheese on Mountain Project", "Mountain Project", "OpenBeta"]) {
        fireEvent.click(screen.getByRole("link", { name: label }));
      }
      expect(vi.mocked(Linking.openURL).mock.calls.map(([url]) => url)).toEqual([
        links[0]?.url,
        links[3]?.url,
        links[2]?.url,
      ]);
    },
  );
  it("links a single provider's attribution to its tick history", () => {
    render(
      <ClimbingLogEntrySources
        name="Swiss Cheese"
        sourceName="OpenBeta"
        links={links.filter((link) => link.providerId === "openbeta")}
      />,
    );
    fireEvent.click(screen.getByRole("link", { name: "OpenBeta" }));
    expect(Linking.openURL).toHaveBeenCalledWith(links[2]?.url);
  });
  it("reports an opening failure and shows the reason", async () => {
    const error = new Error("No browser available");
    vi.mocked(Linking.openURL).mockRejectedValueOnce(error);
    render(
      <ClimbingLogEntrySources name="Swiss Cheese" sourceName="Mountain Project" links={links} />,
    );
    fireEvent.click(screen.getByRole("link", { name: "Mountain Project" }));
    await waitFor(() =>
      expect(captureException).toHaveBeenCalledWith(error, {
        source: "open-external-url",
        caller: "climbing-entry-source",
      }),
    );
    expect(Alert.alert).toHaveBeenCalledWith(
      "Unable to open source",
      `Open this source in your browser: ${links[3]?.url}`,
    );
  });
  it("opens the provider's tick history when no route is available", () => {
    render(
      <ClimbingLogEntrySources
        name="Swiss Cheese"
        sourceName={null}
        links={links.filter((link) => link.kind === "ticks" && link.providerId === "openbeta")}
      />,
    );
    expect(screen.getByText("Swiss Cheese")).toBeTruthy();
    expect(screen.getByText("OpenBeta")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "OpenBeta" }));
    expect(Linking.openURL).toHaveBeenCalledWith(links[2]?.url);
  });
  it("preserves an unlinked source beside a different provider's tick history", () => {
    render(
      <ClimbingLogEntrySources
        name="Swiss Cheese"
        sourceName="Kaya"
        links={links.filter((link) => link.providerId === "openbeta")}
      />,
    );
    expect(screen.getByText("Kaya")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Kaya" })).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "OpenBeta" }));
    expect(Linking.openURL).toHaveBeenCalledWith(links[2]?.url);
  });
  it("keeps mixed attribution readable when one provider has no tick history", () => {
    render(
      <ClimbingLogEntrySources
        name="Swiss Cheese"
        sourceName="Mountain Project, Kaya"
        links={links.filter((link) => link.providerId === "mountain-project")}
      />,
    );
    fireEvent.click(screen.getByRole("link", { name: "Mountain Project" }));
    expect(Linking.openURL).toHaveBeenCalledWith(links[3]?.url);
    expect(screen.getByText("Kaya")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Kaya" })).toBeNull();
  });
  it("keeps an entry without verified destinations readable", () => {
    render(<ClimbingLogEntrySources name="Imported route" sourceName="Kaya" links={[]} />);
    expect(screen.getByText("Imported route")).toBeTruthy();
    expect(screen.getByText("Kaya")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("keeps provider provenance as text when only a route destination is known", () => {
    render(
      <ClimbingLogEntrySources
        name="Swiss Cheese"
        sourceName="Mountain Project"
        links={links.filter(
          (link) => link.kind === "route" && link.providerId === "mountain-project",
        )}
      />,
    );
    expect(screen.getByRole("link", { name: "Swiss Cheese on Mountain Project" })).toBeTruthy();
    expect(screen.getByText("Mountain Project")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Mountain Project" })).toBeNull();
  });
});
