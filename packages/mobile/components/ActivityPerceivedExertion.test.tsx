/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const error: Error | null = null;
  return {
    captureException: vi.fn(),
    invalidate: vi.fn(),
    mutate: vi.fn(),
    mutation: { error, isPending: false },
    invokeMutationSuccess: false,
    invokeMutationError: false,
  };
});

vi.mock("../lib/telemetry", () => ({ captureException: mocks.captureException }));
vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ activity: { byId: { invalidate: mocks.invalidate } } }),
    activity: {
      setPerceivedExertion: {
        useMutation: (options: {
          onSuccess?: (result: { perceivedExertion: number | null }) => void;
          onError?: (error: Error) => void;
        }) => ({
          ...mocks.mutation,
          mutate: (input: { id: string; value: number | null }) => {
            mocks.mutate(input);
            if (mocks.invokeMutationSuccess) {
              options.onSuccess?.({ perceivedExertion: input.value });
            }
            if (mocks.invokeMutationError) {
              options.onError?.(new Error("RPE unavailable"));
            }
          },
        }),
      },
    },
  },
}));

import { ActivityPerceivedExertion } from "./ActivityPerceivedExertion";

describe("ActivityPerceivedExertion", () => {
  beforeEach(() => {
    mocks.captureException.mockReset();
    mocks.invalidate.mockReset();
    mocks.mutate.mockReset();
    mocks.mutation.error = null;
    mocks.mutation.isPending = false;
    mocks.invokeMutationSuccess = false;
    mocks.invokeMutationError = false;
  });

  it("adjusts and saves a session effort, and can clear it", () => {
    render(<ActivityPerceivedExertion activityId="activity-1" value={null} />);

    fireEvent.click(screen.getByLabelText("Increase perceived exertion"));
    fireEvent.click(screen.getByText("Save"));
    expect(mocks.mutate).toHaveBeenCalledWith({ id: "activity-1", value: 1 });

    fireEvent.click(screen.getByText("Clear"));
    expect(mocks.mutate).toHaveBeenLastCalledWith({ id: "activity-1", value: null });
  });

  it("disables writes while pending and renders mutation errors", () => {
    mocks.mutation.isPending = true;
    mocks.mutation.error = new Error("RPE unavailable");

    render(<ActivityPerceivedExertion activityId="activity-1" value={7} />);

    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Clear" })).toHaveProperty("disabled", true);
    expect(screen.getByText("RPE unavailable")).toBeTruthy();
  });

  it("runs mutation success and error callbacks", () => {
    mocks.invokeMutationSuccess = true;
    render(<ActivityPerceivedExertion activityId="activity-1" value={null} />);

    fireEvent.click(screen.getByLabelText("Increase perceived exertion"));
    fireEvent.click(screen.getByText("Save"));
    expect(mocks.invalidate).toHaveBeenCalledWith({ id: "activity-1" });

    mocks.invokeMutationError = true;
    fireEvent.click(screen.getByText("Clear"));
    expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
      operation: "activity.setPerceivedExertion",
    });
  });
});
