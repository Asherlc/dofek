import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push }) }));

describe("More tab", () => {
  it("opens Body, Nutrition and Correlation directly", async () => {
    const { default: MoreScreen } = await import("../../app/(tabs)/more");
    render(<MoreScreen />);

    for (const [name, route] of [
      ["Body", "/body"],
      ["Nutrition", "/nutrition"],
      ["Correlation", "/correlation"],
      ["Data Sources", "/providers"],
      ["Settings", "/settings"],
    ]) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(push).toHaveBeenLastCalledWith(route);
    }
  });
});
