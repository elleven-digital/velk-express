import type { FormValues } from "@/lib/form-values";

/** What a client action returns: null before the first submit; text is already translated. Errors carry the submitted `values`. */
export type ClientState = { error?: string; ok?: string; values?: FormValues } | null;
