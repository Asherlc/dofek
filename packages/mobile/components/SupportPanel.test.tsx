// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SupportPanel } from "./SupportPanel";

describe("SupportPanel", () => {
  it("submits trimmed subject and message without an email override", () => {
    const onSubmit = vi.fn();

    render(<SupportPanel onSubmit={onSubmit} onReset={vi.fn()} isPending={false} />);

    fireEvent.change(screen.getByPlaceholderText("Subject"), {
      target: { value: "  Sync broke  " },
    });
    fireEvent.change(screen.getByPlaceholderText("How can we help?"), {
      target: { value: "  Help please  " },
    });
    fireEvent.click(screen.getByText("Send Message"));

    expect(onSubmit).toHaveBeenCalledWith({
      subject: "Sync broke",
      message: "Help please",
      email: undefined,
    });
  });

  it("includes the optional reply-to email when provided", () => {
    const onSubmit = vi.fn();

    render(<SupportPanel onSubmit={onSubmit} onReset={vi.fn()} isPending={false} />);

    fireEvent.change(screen.getByPlaceholderText("Subject"), {
      target: { value: "Question" },
    });
    fireEvent.change(screen.getByPlaceholderText("How can we help?"), {
      target: { value: "Details" },
    });
    fireEvent.change(screen.getByPlaceholderText("Defaults to your account email"), {
      target: { value: "me@example.com" },
    });
    fireEvent.click(screen.getByText("Send Message"));

    expect(onSubmit).toHaveBeenCalledWith({
      subject: "Question",
      message: "Details",
      email: "me@example.com",
    });
  });

  it("disables submission until subject and message are filled", () => {
    const onSubmit = vi.fn();

    render(<SupportPanel onSubmit={onSubmit} onReset={vi.fn()} isPending={false} />);

    fireEvent.click(screen.getByText("Send Message"));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("exposes submission as a named disabled accessibility action", () => {
    render(<SupportPanel onSubmit={vi.fn()} onReset={vi.fn()} isPending={false} />);

    const submitButton = screen.getByRole("button", { name: "Send Message" });

    expect(submitButton.getAttribute("aria-label")).toBe("Send Message");
    expect(submitButton.getAttribute("aria-disabled")).toBe("true");
  });

  it("announces pending submission as busy", () => {
    render(<SupportPanel onSubmit={vi.fn()} onReset={vi.fn()} isPending />);

    const submitButton = screen.getByRole("button", { name: "Send Message" });
    expect(submitButton.getAttribute("aria-busy")).toBe("true");
    expect(submitButton.getAttribute("aria-disabled")).toBe("true");
  });

  it("shows the error message", () => {
    render(
      <SupportPanel
        onSubmit={vi.fn()}
        onReset={vi.fn()}
        isPending={false}
        errorMessage="We couldn't submit your request right now."
      />,
    );

    expect(screen.getByText("We couldn't submit your request right now.")).toBeTruthy();
  });

  it("shows the ticket ID and resets on success", () => {
    const onReset = vi.fn();

    render(
      <SupportPanel
        onSubmit={vi.fn()}
        onReset={onReset}
        isPending={false}
        ticketId="ticket-1042"
      />,
    );

    expect(screen.getByText("Ticket ID: ticket-1042")).toBeTruthy();

    fireEvent.click(screen.getByText("Submit another request"));

    expect(onReset).toHaveBeenCalled();
  });
});
