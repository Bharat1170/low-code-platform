/*
 * Form builder schema types (8.17.8).
 *
 * Everything in this file describes PERSISTED data: it must stay plain
 * JSON (strings, finite numbers, booleans, null, arrays and plain
 * objects). No functions, RegExp objects, Dates, React elements or class
 * instances may ever be stored in a FormSchema.
 */

export const FIELD_TYPES = [
  "TEXT",
  "EMAIL",
  "DROPDOWN",
  "CHECKBOX",
  "DATE",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/* Version of the persisted schema format (not a form version). */
export const FORM_SCHEMA_VERSION = 1;

/* ---------- Validation configuration (data only, no engine) ---------- */

/*
 * Rules the later validation engine will consume. Every key is optional.
 * `pattern` is stored as a string, never as a RegExp.
 * Note: whether a field is required is the field-level `required` flag;
 * `required` here lets a rule set state it explicitly and the engine
 * should treat a field as required if either is true.
 */
export interface ValidationConfig {
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: string;
  email?: boolean;
  /* DATE fields only: inclusive bounds as "YYYY-MM-DD" strings. */
  minDate?: string;
  maxDate?: string;
}

/* ---------- Type-specific configuration ---------- */

export interface TextConfig {
  placeholder: string;
  defaultValue: string;
}

export interface EmailConfig {
  placeholder: string;
  defaultValue: string;
}

export interface DropdownOption {
  label: string;
  value: string;
}

export interface DropdownConfig {
  placeholder: string;
  options: DropdownOption[];
  defaultValue: string;
}

export interface CheckboxConfig {
  defaultValue: boolean;
}

/* Date-only value as "YYYY-MM-DD" (a string, never a Date object), or "". */
export interface DateConfig {
  defaultValue: string;
}

/* ---------- Field definitions (discriminated by `type`) ---------- */

/*
 * Placeholder for the future conditional logic engine. Always null for
 * now so persisted schemas already carry the slot.
 */
export type ConditionalLogic = null;

interface BaseFieldDefinition<T extends FieldType, C> {
  id: string;
  type: T;
  label: string;
  description: string;
  required: boolean;
  config: C;
  validation: ValidationConfig;
  conditionalLogic: ConditionalLogic;
}

export type TextFieldDefinition = BaseFieldDefinition<"TEXT", TextConfig>;
export type EmailFieldDefinition = BaseFieldDefinition<
  "EMAIL",
  EmailConfig
>;
export type DropdownFieldDefinition = BaseFieldDefinition<
  "DROPDOWN",
  DropdownConfig
>;
export type CheckboxFieldDefinition = BaseFieldDefinition<
  "CHECKBOX",
  CheckboxConfig
>;

export type DateFieldDefinition = BaseFieldDefinition<"DATE", DateConfig>;

export type FormFieldDefinition =
  | TextFieldDefinition
  | EmailFieldDefinition
  | DropdownFieldDefinition
  | CheckboxFieldDefinition
  | DateFieldDefinition;

/* Maps a field type to its config / definition type. */
export interface FieldConfigByType {
  TEXT: TextConfig;
  EMAIL: EmailConfig;
  DROPDOWN: DropdownConfig;
  CHECKBOX: CheckboxConfig;
  DATE: DateConfig;
}

export interface FieldDefinitionByType {
  TEXT: TextFieldDefinition;
  EMAIL: EmailFieldDefinition;
  DROPDOWN: DropdownFieldDefinition;
  CHECKBOX: CheckboxFieldDefinition;
  DATE: DateFieldDefinition;
}

export type FieldConfig = FieldConfigByType[FieldType];

/* ---------- Form schema ---------- */

export interface FormSchema {
  version: number;
  fields: FormFieldDefinition[];
}

/* ---------- Registry metadata (serializable, no React) ---------- */

export type FieldCategory = "basic" | "choice";

/* Identifier the UI maps to an actual icon later. */
export type FieldIconId =
  | "text"
  | "email"
  | "dropdown"
  | "checkbox"
  | "date";

export interface FieldRegistryEntry<T extends FieldType> {
  type: T;
  label: string;
  icon: FieldIconId;
  category: FieldCategory;
  defaultLabel: string;
  defaultConfig: FieldConfigByType[T];
  defaultValidation: ValidationConfig;
}

export type FieldRegistry = {
  readonly [T in FieldType]: FieldRegistryEntry<T>;
};
