/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddJournalEntryModal } from "./AddJournalEntryModal.tsx";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  createMutation: vi.fn(),
  questionsQuery: vi.fn(),
}));

vi.mock("../lib/telemetry.ts", () => ({
  captureException: mocks.captureException,
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    journal: {
      questions: {
        useQuery: mocks.questionsQuery,
      },
      create: {
        useMutation: mocks.createMutation,
      },
    },
  },
}));

const question = {
  slug: "reflection",
  display_name: "Daily reflection",
  category: "wellness",
  data_type: "text",
  unit: null,
  sort_order: 1,
};

describe("AddJournalEntryModal", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.captureException.mockReset();
    mocks.questionsQuery.mockReset();
    mocks.questionsQuery.mockReturnValue({ data: [question], error: null, isLoading: false });
    mocks.createMutation.mockReset();
    mocks.createMutation.mockReturnValue({ error: null, isPending: false, mutate: vi.fn() });
  });

  it("opens as a named dialog, focuses the date, and closes with Escape", async () => {
    const onClose = vi.fn();
    render(<AddJournalEntryModal isOpen onClose={onClose} onSuccess={vi.fn()} />);

    const dateInput = screen.getByLabelText("Date");
    expect(
      screen.getByRole("dialog", { name: "Add Journal Entry" }).getAttribute("aria-modal"),
    ).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(dateInput));

    fireEvent.keyDown(dateInput, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows a questions failure instead of an empty selector", () => {
    const refetch = vi.fn();
    mocks.questionsQuery.mockReturnValue({
      data: undefined,
      error: new Error("Journal questions are unavailable"),
      isFetching: false,
      isLoading: false,
      refetch,
    });

    render(<AddJournalEntryModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} />);

    expect(screen.getByText("Journal questions are unavailable")).toBeDefined();
    expect(screen.queryByRole("combobox", { name: "Question" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry journal questions" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("shows and reports create failures without clearing the form", () => {
    const createError = new Error("Journal entry was not saved");
    let onError: ((error: unknown) => void) | undefined;
    let meta: unknown;
    const mutate = vi.fn();
    mocks.createMutation.mockImplementation(
      (options: { meta?: unknown; onError?: (error: unknown) => void }) => {
        meta = options.meta;
        onError = options.onError;
        return { error: createError, isPending: false, mutate };
      },
    );

    render(<AddJournalEntryModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Question" }), {
      target: { value: "reflection" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Answer" }), {
      target: { value: "Keep this answer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    act(() => onError?.(createError));

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        questionSlug: "reflection",
        answerText: "Keep this answer",
      }),
    );
    expect(meta).toEqual({ errorReportedLocally: true });
    expect(screen.getByText(createError.message)).toBeDefined();
    const answer = screen.getByRole("textbox", { name: "Answer" });
    expect(answer).toBeInstanceOf(HTMLTextAreaElement);
    if (!(answer instanceof HTMLTextAreaElement)) {
      throw new Error("Expected journal answer textarea");
    }
    expect(answer.value).toBe("Keep this answer");
    expect(mocks.captureException).toHaveBeenCalledWith(createError, {
      operation: "journal.create",
    });
  });
});
