import type { FormValues } from "@/lib/form-values";

/** What a settings action returns: null before the first submit; text is already translated. Errors carry the submitted `values`. */
export type SettingsState = { error?: string; ok?: string; values?: FormValues } | null;
