import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Alert, Linking } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureException } from "../lib/telemetry";
import { ClimbingEntrySources } from "./ClimbingEntrySources";

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
];
describe("ClimbingEntrySources", () => {
  beforeEach(() => vi.clearAllMocks());
  it("opens the original route, additional source route and public ticks", () => {
    render(
      <ClimbingEntrySources
        name="Swiss Cheese"
        sourceName="Mountain Project, OpenBeta"
        links={links}
      />,
    );
    for (const label of [
      "Swiss Cheese on Mountain Project",
      "Swiss Cheese route on OpenBeta",
      "OpenBeta ticks",
    ]) {
      fireEvent.click(screen.getByRole("link", { name: label }));
    }
    expect(vi.mocked(Linking.openURL).mock.calls.map(([url]) => url)).toEqual(
      links.map((link) => link.url),
    );
  });
  it("reports an opening failure and shows the reason", async () => {
    const error = new Error("No browser available");
    vi.mocked(Linking.openURL).mockRejectedValueOnce(error);
    render(
      <ClimbingEntrySources name="Swiss Cheese" sourceName="Mountain Project" links={links} />,
    );
    fireEvent.click(screen.getByRole("link", { name: "Swiss Cheese on Mountain Project" }));
    await waitFor(() =>
      expect(captureException).toHaveBeenCalledWith(error, {
        source: "open-external-url",
        caller: "climbing-entry-source",
      }),
    );
    expect(Alert.alert).toHaveBeenCalledWith(
      "Unable to open source",
      `Open this source in your browser: ${links[0]?.url}`,
    );
  });
  it("keeps an entry without verified destinations readable", () => {
    render(<ClimbingEntrySources name="Imported route" sourceName="Kaya" links={[]} />);
    expect(screen.getByText("Imported route")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
