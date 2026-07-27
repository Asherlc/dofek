import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import StorybookDateTimePicker from "./react-native-community-datetimepicker";

describe("StorybookDateTimePicker", () => {
  it("lets the story exercise date selection", () => {
    const onChange = vi.fn();

    render(
      <StorybookDateTimePicker
        accessibilityLabel="Period start date"
        onChange={onChange}
        value={new Date(2026, 6, 27, 12)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Period start date" }));

    expect(onChange).toHaveBeenCalledWith(
      {
        type: "set",
        nativeEvent: {
          timestamp: new Date(2026, 6, 26, 12).getTime(),
          utcOffset: new Date(2026, 6, 26, 12).getTimezoneOffset(),
        },
      },
      new Date(2026, 6, 26, 12),
    );
  });
});
