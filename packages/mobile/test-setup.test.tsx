import { fireEvent, render, screen } from "@testing-library/react";
import { Pressable, TextInput } from "react-native";
import { describe, expect, it, vi } from "vitest";

describe("Pressable test mock", () => {
  it("ends only active presses when the pointer leaves", () => {
    const onPressIn = vi.fn();
    const onPressOut = vi.fn();

    render(
      <Pressable
        accessibilityLabel="Test press"
        accessibilityRole="button"
        onPressIn={onPressIn}
        onPressOut={onPressOut}
      />,
    );

    const button = screen.getByRole("button", { name: "Test press" });
    fireEvent.mouseLeave(button);
    expect(onPressOut).not.toHaveBeenCalled();

    fireEvent.mouseDown(button);
    expect(onPressIn).toHaveBeenCalledOnce();

    fireEvent.mouseLeave(button);
    expect(onPressOut).toHaveBeenCalledOnce();

    fireEvent.mouseUp(button);
    expect(onPressOut).toHaveBeenCalledOnce();
  });
});

describe("TextInput test mock", () => {
  it("preserves React Native accessibility labels and direct ARIA labels", () => {
    render(
      <>
        <TextInput accessibilityLabel="React Native label" />
        <TextInput aria-label="Direct ARIA label" />
      </>,
    );

    expect(screen.getByLabelText("React Native label")).toBeTruthy();
    expect(screen.getByLabelText("Direct ARIA label")).toBeTruthy();
  });

  it("does not add an input type to multiline text areas", () => {
    render(<TextInput accessibilityLabel="Notes" multiline />);

    expect(screen.getByLabelText("Notes").getAttribute("type")).toBeNull();
  });
});
