import * as Dialog from "@radix-ui/react-dialog";
import { type ReactNode, type RefObject, useEffect, useRef } from "react";

interface ModalDialogProps {
  children: ReactNode;
  closeOnEscape?: boolean;
  closeOnInteractOutside?: boolean;
  contentClassName?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  open: boolean;
  overlayClassName?: string;
}

export function ModalDialog({
  children,
  closeOnEscape = true,
  closeOnInteractOutside = false,
  contentClassName = "",
  initialFocusRef,
  onClose,
  open,
  overlayClassName = "bg-black/60 backdrop-blur-sm",
}: ModalDialogProps) {
  const returnFocusRef = useRef<HTMLElement | null>(null);

  function restoreFocus() {
    if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
  }

  useEffect(
    () => () => {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    },
    [],
  );

  function closeDialog() {
    restoreFocus();
    onClose();
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeDialog();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay aria-hidden="true" className={`fixed inset-0 z-50 ${overlayClassName}`} />
        <Dialog.Content
          aria-modal="true"
          aria-describedby={undefined}
          className={`fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 ${contentClassName}`}
          onEscapeKeyDown={(event) => {
            if (!closeOnEscape) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            if (!returnFocusRef.current) return;
            event.preventDefault();
            restoreFocus();
          }}
          onOpenAutoFocus={(event) => {
            if (document.activeElement instanceof HTMLElement) {
              returnFocusRef.current = document.activeElement;
            }
            if (!initialFocusRef?.current) return;
            event.preventDefault();
            initialFocusRef.current.focus();
          }}
          onPointerDownOutside={(event) => {
            if (!closeOnInteractOutside) event.preventDefault();
          }}
        >
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const ModalDialogTitle = Dialog.Title;
export const ModalDialogDescription = Dialog.Description;
