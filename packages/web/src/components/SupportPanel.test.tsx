/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SupportPanel } from "./SupportPanel.tsx";

const createTicketMutate = vi.fn();
let createTicketState: {
  isPending: boolean;
  isSuccess: boolean;
  error: { message: string } | null;
  data: { ticketId: string } | undefined;
};
const resetMutation = vi.fn();

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    support: {
      createTicket: {
        useMutation: () => ({
          mutate: createTicketMutate,
          reset: resetMutation,
          isPending: createTicketState.isPending,
          isSuccess: createTicketState.isSuccess,
          error: createTicketState.error,
          data: createTicketState.data,
        }),
      },
    },
  },
}));

describe("SupportPanel", () => {
  beforeEach(() => {
    createTicketMutate.mockReset();
    resetMutation.mockReset();
    createTicketState = {
      isPending: false,
      isSuccess: false,
      error: null,
      data: undefined,
    };
  });

  afterEach(() => {
    cleanup();
  });

  it("submits trimmed subject and message without an email override", () => {
    render(<SupportPanel />);

    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "  Sync broke  " } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "  Help please  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send Message" }));

    expect(createTicketMutate).toHaveBeenCalledWith(
      { subject: "Sync broke", message: "Help please", email: undefined },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("includes the optional reply-to email when provided", () => {
    render(<SupportPanel />);

    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Question" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Details" } });
    fireEvent.change(screen.getByLabelText("Reply-to email (optional)"), {
      target: { value: "me@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send Message" }));

    expect(createTicketMutate).toHaveBeenCalledWith(
      { subject: "Question", message: "Details", email: "me@example.com" },
      expect.anything(),
    );
  });

  it("shows the server error message", () => {
    createTicketState.error = { message: "We couldn't submit your request right now." };

    render(<SupportPanel />);

    expect(screen.getByText("We couldn't submit your request right now.")).toBeTruthy();
  });

  it("shows the ticket ID on success and can reset", async () => {
    createTicketState.isSuccess = true;
    createTicketState.data = { ticketId: "ticket-1042" };

    render(<SupportPanel />);

    expect(screen.getByText("Ticket ID: ticket-1042")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Submit another request" }));

    await waitFor(() => {
      expect(resetMutation).toHaveBeenCalled();
    });
  });
});
