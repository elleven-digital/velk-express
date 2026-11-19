"use client";

import { useFormStatus } from "react-dom";
import type { ComponentProps } from "react";
import { buttonClasses, cn, type ButtonSize, type ButtonVariant } from "./ui";

/** A submit button that shows a spinner and locks while its form is pending. */
export function SubmitButton({
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}: ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      {...props}
      // After the spread, so an explicit `disabled={false}` can't re-enable
      // the button while the form is submitting (double submits).
      disabled={pending || props.disabled}
      className={cn(buttonClasses(variant, size), className)}
    >
      {pending ? (
        <span
          aria-hidden
          className="size-3.5 rounded-full border-2 border-current border-t-transparent animate-spin"
        />
      ) : null}
      {children}
    </button>
  );
}
