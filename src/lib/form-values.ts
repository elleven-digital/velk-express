/** The text a form was submitted with, by field name. Sent back with an error so the form keeps what was typed. */
export type FormValues = Record<string, string>;

const MAX_LENGTH = 10_000;

/**
 * The text fields of a submit, to send back with an error. Files and missing keys are skipped;
 * each value is cut to 10_000 chars. Never list a password or a hidden security field in `keys`.
 *
 * In the form: `defaultValue={state?.values?.x ?? saved}` for inputs and textareas, and
 * `defaultChecked={state?.values ? state.values.x === "on" : saved}` for checkboxes. React resets
 * the form after the action, back to those defaults. A `<select>` keeps the default it first
 * mounted with, so also give it `key={state?.values?.x}`.
 */
export function formValues(formData: FormData, keys: readonly string[]): FormValues {
  const values: FormValues = {};
  for (const key of keys) {
    const value = formData.get(key);
    if (typeof value === "string") values[key] = value.slice(0, MAX_LENGTH);
  }
  return values;
}
