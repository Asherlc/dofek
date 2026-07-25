// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddJournalEntryModal } from "./AddJournalEntryModal.tsx";

const createMutate = vi.fn();

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    journal: {
      questions: {
        useQuery: () => ({
          data: [
            {
              slug: "energy",
              display_name: "Energy",
              category: "wellbeing",
              data_type: "numeric",
              unit: null,
              sort_order: 1,
            },
          ],
        }),
      },
      create: {
        useMutation: () => ({ isPending: false, mutate: createMutate }),
      },
    },
  },
}));

afterEach(cleanup);

describe("AddJournalEntryModal", () => {
  it("opens as a named dialog, focuses the date, and closes with Escape", async () => {
    const onClose = vi.fn();
    render(<AddJournalEntryModal isOpen onClose={onClose} onSuccess={() => {}} />);

    const dateInput = screen.getByLabelText("Date");
    expect(screen.getByRole("dialog", { name: "Add Journal Entry" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    await waitFor(() => expect(dateInput).toHaveFocus());

    fireEvent.keyDown(dateInput, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
