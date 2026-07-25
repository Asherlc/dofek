import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AlertsBell } from "./AlertsBell";

vi.mock("@expo/vector-icons", () => ({
  Ionicons: ({ name }: { name: string }) => <span>{name}</span>,
}));

describe("AlertsBell", () => {
  it("announces and displays the number of active alerts", () => {
    const onPress = vi.fn();
    render(<AlertsBell activeCount={3} onPress={onPress} />);

    fireEvent.click(screen.getByRole("button", { name: "Alerts, 3 active" }));

    expect(screen.getByText("3")).toBeTruthy();
    expect(onPress).toHaveBeenCalledOnce();
  });

  it("has a quiet accessible label when no alerts are active", () => {
    render(<AlertsBell activeCount={0} onPress={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Alerts" })).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });
});
