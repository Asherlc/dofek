import { type InputHTMLAttributes, useState } from "react";

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  id: string;
  visibilityLabel: string;
};

export function PasswordInput({
  "aria-describedby": describedBy,
  className,
  id,
  onBlur,
  onKeyDown,
  onKeyUp,
  visibilityLabel,
  ...inputProps
}: PasswordInputProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [capsLockActive, setCapsLockActive] = useState(false);
  const capsLockMessageId = `${id}-caps-lock`;
  const ariaDescribedBy = [describedBy, capsLockActive ? capsLockMessageId : undefined]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <div className="relative">
        <input
          {...inputProps}
          id={id}
          type={isVisible ? "text" : "password"}
          aria-describedby={ariaDescribedBy || undefined}
          className={`${className ?? ""} pr-16`}
          onBlur={(event) => {
            setCapsLockActive(false);
            onBlur?.(event);
          }}
          onKeyDown={(event) => {
            setCapsLockActive(event.getModifierState("CapsLock"));
            onKeyDown?.(event);
          }}
          onKeyUp={(event) => {
            setCapsLockActive(event.getModifierState("CapsLock"));
            onKeyUp?.(event);
          }}
        />
        <button
          type="button"
          onClick={() => setIsVisible((visible) => !visible)}
          aria-label={`${isVisible ? "Hide" : "Show"} ${visibilityLabel}`}
          className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-muted hover:text-foreground transition-colors"
        >
          {isVisible ? "Hide" : "Show"}
        </button>
      </div>
      {capsLockActive ? (
        <output id={capsLockMessageId} className="mt-1 block text-xs text-amber-400">
          Caps Lock is on.
        </output>
      ) : null}
    </>
  );
}
