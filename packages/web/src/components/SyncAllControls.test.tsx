// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncAllControls } from "./SyncAllControls.tsx";

afterEach(cleanup);

describe("SyncAllControls", () => {
  it("makes recent sync the primary directly available action", () => {
    const onRecentSync = vi.fn();
    render(<SyncAllControls busy={false} onRecentSync={onRecentSync} onFullSync={vi.fn()} />);

    const recent = screen.getByRole("button", {
      name: "Sync all providers for the last 7 days",
    });
    const full = screen.getByRole("button", {
      name: "Sync full history for all providers",
    });

    expect(recent.compareDocumentPosition(full) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(recent.className).toContain("bg-accent");
    expect(full.className).not.toContain("bg-accent text");
    expect(screen.getByText("Updates the last 7 days for every connected provider.")).toBeVisible();

    fireEvent.click(recent);
    expect(onRecentSync).toHaveBeenCalledOnce();
  });

  it("explains full-history impact and requires explicit confirmation", async () => {
    const onFullSync = vi.fn();
    render(<SyncAllControls busy={false} onRecentSync={vi.fn()} onFullSync={onFullSync} />);

    fireEvent.click(screen.getByRole("button", { name: "Sync full history for all providers" }));

    const dialog = screen.getByRole("dialog", { name: "Sync full provider history?" });
    expect(
      within(dialog).getByText(/all history each connected provider makes available/i),
    ).toBeVisible();
    expect(within(dialog).getByText(/more provider requests/i)).toBeVisible();
    expect(within(dialog).getByText(/matching records are updated/i)).toBeVisible();
    expect(within(dialog).getByText(/activities removed upstream may be hidden/i)).toBeVisible();
    expect(
      within(dialog).getByText(/does not erase or rebuild unrelated Dofek data/i),
    ).toBeVisible();
    expect(onFullSync).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Start full sync" }));
    expect(onFullSync).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("puts Cancel first, focuses it, and restores the trigger after Escape", async () => {
    render(<SyncAllControls busy={false} onRecentSync={vi.fn()} onFullSync={vi.fn()} />);
    const trigger = screen.getByRole("button", {
      name: "Sync full history for all providers",
    });

    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Sync full provider history?" });
    const actions = within(dialog).getAllByRole("button");
    expect(actions.map((action) => action.textContent)).toEqual(["Cancel", "Start full sync"]);
    const cancel = actions[0];
    if (!cancel) throw new Error("Expected the full-sync dialog to include Cancel");
    await waitFor(() => expect(cancel).toHaveFocus());

    fireEvent.keyDown(cancel, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("disables both actions for active work and keeps progress visible", () => {
    render(<SyncAllControls busy onRecentSync={vi.fn()} onFullSync={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: "Sync all providers for the last 7 days" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Sync full history for all providers" }),
    ).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Sync in progress. Follow each provider below for progress.",
    );
  });

  it("shows the exact trigger error", () => {
    render(
      <SyncAllControls
        busy={false}
        errorMessage="Garmin credentials expired. Reconnect Garmin."
        onRecentSync={vi.fn()}
        onFullSync={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Garmin credentials expired. Reconnect Garmin.",
    );
  });
});
