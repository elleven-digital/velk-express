"use client";

import { useActionState, useState, useTransition, type ReactNode } from "react";
import type { MessageActionState } from "./chat";
import { Icon } from "./icons";
import { SubmitButton } from "./submit-button";
import { buttonClasses, cn, Select, type ButtonSize, type ButtonVariant } from "./ui";

/** A refusal shown under the control that caused it. */
function ControlError({ text }: { text: string | null | undefined }) {
  return text ? (
    <p role="alert" className="basis-full mt-1.5 text-[0.8125rem] font-medium text-danger">
      {text}
    </p>
  ) : null;
}

/**
 * A button that runs a server action (close, assume, remove...) and shows what it refuses with.
 * With `confirm`, the browser asks first.
 */
export function ControlButton({
  action,
  confirm,
  variant = "secondary",
  size = "sm",
  className,
  label,
  children,
}: {
  action: () => Promise<MessageActionState>;
  confirm?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  /** Names an icon-only button. */
  label?: string;
  children: ReactNode;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        disabled={pending}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          start(async () => {
            const result = await action();
            setError(result?.error ?? null);
          });
        }}
        className={cn(buttonClasses(variant, size), className)}
      >
        {pending ? (
          <span aria-hidden className="size-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
        ) : null}
        {children}
      </button>
      <ControlError text={error} />
    </>
  );
}

/** A select plus a "+" button: picks one option and sends its value as `name`. */
export function ControlSelect({
  action,
  name,
  placeholder,
  options,
  label,
}: {
  action: (fd: FormData) => Promise<MessageActionState>;
  name: string;
  placeholder: string;
  options: { value: string; label: string }[];
  label: string;
}) {
  const [state, formAction] = useActionState((_prev: MessageActionState, fd: FormData) => action(fd), null);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <Select name={name} required aria-label={label} defaultValue="" className="flex-1 min-w-0 !h-8 !py-1">
        <option value="">{placeholder}…</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
      <SubmitButton variant="secondary" size="sm" className="!px-0 w-8" aria-label={label}>
        <Icon name="plus" />
      </SubmitButton>
      <ControlError text={state?.error} />
    </form>
  );
}
