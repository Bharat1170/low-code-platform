/* Value a person has entered for one field. Never stored in the schema. */
export type FieldValue = string | boolean;

export type FieldValues = Record<string, FieldValue>;
export type FieldErrors = Record<string, string>;

/*
 * builder:   read-only rendering, nothing can be entered
 * preview:   interactive, renders the current draft; local only
 * published: interactive, renders an immutable published version
 */
export type FormRendererMode = "builder" | "preview" | "published";
