import type { FormValues } from "@/lib/form-values";

/** What a charge form returns: null before the first submit; text is already translated. Errors carry the submitted `values`. */
export type ChargeState = { error?: string; ok?: string; values?: FormValues } | null;
