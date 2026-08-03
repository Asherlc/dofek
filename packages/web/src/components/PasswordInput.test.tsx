// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PasswordInput } from "./PasswordInput.tsx";

describe("PasswordInput", () => {
  afterEach(cleanup);

  it("reveals the password independently and reports Caps Lock state", () => {
    render(
      <PasswordInput
        id="password"
        visibilityLabel="password"
        aria-label="Password"
        aria-describedby="password-hint"
      />,
    );

    const input = screen.getByLabelText("Password");
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input.getAttribute("type")).toBe("text");

    const capsLockEvent = new KeyboardEvent("keydown", { bubbles: true });
    Object.defineProperty(capsLockEvent, "getModifierState", {
      value: (modifier: string) => modifier === "CapsLock",
    });
    fireEvent(input, capsLockEvent);
    expect(screen.getByRole("status")).toHaveTextContent("Caps Lock is on.");
    expect(input.getAttribute("aria-describedby")).toBe("password-hint password-caps-lock");

    const capsLockOffEvent = new KeyboardEvent("keyup", { bubbles: true });
    Object.defineProperty(capsLockOffEvent, "getModifierState", {
      value: () => false,
    });
    fireEvent(input, capsLockOffEvent);
    expect(screen.queryByRole("status")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBe("password-hint");
  });
});
