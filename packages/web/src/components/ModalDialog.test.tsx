// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalDialog, ModalDialogTitle } from "./ModalDialog.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function DialogHarness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const firstActionRef = useRef<HTMLButtonElement | null>(null);

  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open settings
      </button>
      <button type="button">Background action</button>
      <ModalDialog
        open={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        contentClassName="w-full max-w-sm"
        initialFocusRef={firstActionRef}
      >
        <ModalDialogTitle>Account settings</ModalDialogTitle>
        <button ref={firstActionRef} type="button">
          First action
        </button>
        <button type="button">Last action</button>
      </ModalDialog>
    </div>
  );
}

describe("ModalDialog", () => {
  it.each(["Escape", "Close"])(
    "returns focus to an SVG trigger after %s unmounts the dialog",
    async (dismissal) => {
      function SvgDialogHarness() {
        const [open, setOpen] = useState(false);
        const svgRef = useRef<SVGSVGElement>(null);
        useEffect(() => {
          const marker = document.createElementNS("http://www.w3.org/2000/svg", "path");
          marker.setAttribute("role", "button");
          marker.setAttribute("aria-label", "Located climb");
          marker.setAttribute("tabindex", "0");
          marker.addEventListener("keydown", (event) => {
            if (event.key === "Enter") setOpen(true);
          });
          svgRef.current?.append(marker);
          return () => marker.remove();
        }, []);
        return (
          <>
            <svg ref={svgRef}>
              <title>Climbing locations</title>
            </svg>
            {open && (
              <ModalDialog open onClose={() => setOpen(false)}>
                <ModalDialogTitle>Climb details</ModalDialogTitle>
                <button type="button" onClick={() => setOpen(false)}>
                  Close
                </button>
              </ModalDialog>
            )}
          </>
        );
      }
      render(<SvgDialogHarness />);
      const marker = screen.getByRole("button", { name: "Located climb" });
      if (!(marker instanceof SVGElement)) throw new Error("Expected a real SVG source marker");
      marker.focus();
      expect(marker).toHaveFocus();
      fireEvent.keyDown(marker, { key: "Enter" });
      const close = screen.getByRole("button", { name: "Close" });
      await waitFor(() => expect(close).toHaveFocus());
      if (dismissal === "Escape") fireEvent.keyDown(close, { key: "Escape" });
      else fireEvent.click(close);
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(marker).toHaveFocus());
    },
  );

  it("announces its visible title and makes background content inaccessible", async () => {
    render(<DialogHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));

    expect(screen.getByRole("dialog", { name: "Account settings" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    await waitFor(() => {
      const backgroundAction = screen.getByRole("button", {
        name: "Background action",
        hidden: true,
      });
      expect(backgroundAction.closest("[aria-hidden='true']")).not.toBeNull();
    });
  });

  it("moves focus inside, traps Tab in both directions, and restores trigger focus", async () => {
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "Open settings" });
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");

    trigger.focus();
    fireEvent.click(trigger);

    const first = screen.getByRole("button", { name: "First action" });
    const last = screen.getByRole("button", { name: "Last action" });
    await waitFor(() => expect(first).toHaveFocus());
    const firstFocusCalls = focusSpy.mock.calls.filter(
      (_call, index) => focusSpy.mock.contexts[index] === first,
    );
    expect(firstFocusCalls.length).toBeGreaterThan(0);
    expect(firstFocusCalls.every(([options]) => options?.preventScroll === true)).toBe(true);

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();

    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(last, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("does not dismiss a protected operation with Escape or an outside pointer", () => {
    const onClose = vi.fn();
    render(
      <div>
        <button type="button">Background</button>
        <ModalDialog open onClose={onClose} closeOnEscape={false} closeOnInteractOutside={false}>
          <ModalDialogTitle>Deleting provider data</ModalDialogTitle>
          <button type="button">Working</button>
        </ModalDialog>
      </div>,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Working" }), { key: "Escape" });
    const overlay = document.querySelector("[data-state='open'][aria-hidden='true']");
    if (!(overlay instanceof HTMLElement)) throw new Error("Expected the dialog overlay");
    fireEvent.pointerDown(overlay);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("dismisses from an outside pointer when the caller opts in", async () => {
    const onClose = vi.fn();
    render(
      <div>
        <button type="button">Background</button>
        <ModalDialog open onClose={onClose} closeOnInteractOutside>
          <ModalDialogTitle>Record detail</ModalDialogTitle>
          <button type="button">Close</button>
        </ModalDialog>
      </div>,
    );

    const overlay = document.querySelector("[data-state='open'][aria-hidden='true']");
    if (!(overlay instanceof HTMLElement)) throw new Error("Expected the dialog overlay");
    await waitFor(() => {
      fireEvent.pointerDown(overlay, { button: 1 });
      expect(onClose).toHaveBeenCalledOnce();
    });
  });
});
