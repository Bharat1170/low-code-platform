/*
 * Value a person has entered for one field. Never stored in the schema.
 * Checkbox: boolean; multiple choice: the chosen option values; anything
 * else (including numbers and ratings): text.
 */
export type FieldValue = string | boolean | string[];

export type FieldValues = Record<string, FieldValue>;
export type FieldErrors = Record<string, string>;

/*
 * builder:   read-only rendering, nothing can be entered
 * preview:   interactive, renders the current draft; local only
 * published: interactive, renders an immutable published version
 */
export type FormRendererMode = "builder" | "preview" | "published";

/*
 * Result of sending the entered values somewhere (e.g. the server). The
 * renderer stays transport-agnostic: the caller turns any failure into a
 * safe message and, where known, per-field messages keyed by field id.
 */
export type SubmitResult =
  | { ok: true; summary: string }
  | { ok: false; message: string; fieldErrors?: Record<string, string> };

export type FormSubmitHandler = (values: FieldValues) => Promise<SubmitResult>;
