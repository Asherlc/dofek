import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useRef, useState } from "react";
import { ModalDialog, ModalDialogDescription, ModalDialogTitle } from "./ModalDialog.tsx";

function DialogStory({ protectedOperation = false }: { protectedOperation?: boolean }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="p-8">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded bg-accent px-4 py-2 text-on-accent"
      >
        Open dialog
      </button>
      <ModalDialog
        open={open}
        onClose={() => setOpen(false)}
        closeOnEscape={!protectedOperation}
        closeOnInteractOutside={!protectedOperation}
        contentClassName="w-[calc(100%-2rem)] max-w-sm rounded-xl border border-border bg-surface-solid p-6 shadow-2xl"
      >
        <ModalDialogTitle className="text-lg font-semibold text-foreground">
          {protectedOperation ? "Saving changes..." : "Account settings"}
        </ModalDialogTitle>
        <ModalDialogDescription className="mt-2 text-sm text-muted">
          {protectedOperation
            ? "This dialog stays open until the operation finishes."
            : "Keyboard focus remains inside this dialog until it closes."}
        </ModalDialogDescription>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded px-3 py-2 text-sm text-muted"
          >
            Cancel
          </button>
          <button type="button" className="rounded bg-accent px-3 py-2 text-sm text-on-accent">
            Save
          </button>
        </div>
      </ModalDialog>
    </div>
  );
}

function SvgTriggerStory() {
  const [open, setOpen] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    marker.setAttribute("cx", "80");
    marker.setAttribute("cy", "40");
    marker.setAttribute("r", "10");
    marker.setAttribute("fill", "currentColor");
    marker.setAttribute("role", "button");
    marker.setAttribute("aria-label", "Open Blue Arete details");
    marker.setAttribute("tabindex", "0");
    marker.addEventListener("click", () => setOpen(true));
    marker.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setOpen(true);
      }
    });
    svgRef.current?.append(marker);
    return () => marker.remove();
  }, []);
  return (
    <div className="p-8">
      <svg ref={svgRef} viewBox="0 0 160 80" className="h-40 w-80 rounded bg-surface text-accent">
        <title>Climbing locations</title>
      </svg>
      {open && (
        <ModalDialog
          open
          onClose={() => setOpen(false)}
          contentClassName="w-[calc(100%-2rem)] max-w-sm rounded-xl border border-border bg-surface-solid p-6 shadow-2xl"
        >
          <ModalDialogTitle>Blue Arete</ModalDialogTitle>
          <ModalDialogDescription>
            Close these details to return keyboard focus to the map point.
          </ModalDialogDescription>
          <button type="button" onClick={() => setOpen(false)} className="mt-4 text-accent">
            Close
          </button>
        </ModalDialog>
      )}
    </div>
  );
}

const meta = {
  title: "Components/ModalDialog",
  component: ModalDialog,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ModalDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    open: true,
    onClose: () => {},
    children: null,
  },
  render: () => <DialogStory />,
};

export const ProtectedOperation: Story = {
  args: {
    open: true,
    onClose: () => {},
    children: null,
  },
  render: () => <DialogStory protectedOperation />,
};

export const SvgTrigger: Story = {
  args: { open: false, onClose: () => {}, children: null },
  render: () => <SvgTriggerStory />,
};
