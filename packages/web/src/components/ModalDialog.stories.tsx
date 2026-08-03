import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
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
