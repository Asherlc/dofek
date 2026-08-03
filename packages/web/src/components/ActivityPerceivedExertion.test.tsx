/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn(),
  mutate: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("../lib/telemetry.ts", () => ({ captureException: mocks.captureException }));
vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    useUtils: () => ({ activity: { byId: { invalidate: mocks.invalidate } } }),
    activity: {
      setPerceivedExertion: {
        useMutation: () => ({ error: null, isPending: false, mutate: mocks.mutate }),
      },
    },
  },
}));

import { ActivityPerceivedExertion } from "./ActivityPerceivedExertion.tsx";

describe("ActivityPerceivedExertion", () => {
  beforeEach(() => {
    mocks.invalidate.mockReset();
    mocks.mutate.mockReset();
    mocks.captureException.mockReset();
  });

  it("saves the selected session effort and can clear it", () => {
    render(<ActivityPerceivedExertion activityId="activity-1" value={null} />);

    fireEvent.change(screen.getByRole("slider", { name: "Session perceived exertion" }), {
      target: { value: "6" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mocks.mutate).toHaveBeenCalledWith({ id: "activity-1", value: 6 });

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(mocks.mutate).toHaveBeenLastCalledWith({ id: "activity-1", value: null });
  });

  it("requires an explicit slider selection before saving and preserves clear semantics", () => {
    render(<ActivityPerceivedExertion activityId="activity-1" value={null} />);

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(mocks.mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(mocks.mutate).toHaveBeenLastCalledWith({ id: "activity-1", value: null });
  });
});
