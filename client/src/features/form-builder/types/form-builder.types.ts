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
  "TEXTAREA",
  "NUMBER",
  "PHONE",
  "URL",
  "RADIO",
  "MULTI_SELECT",
  "RATING",
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
  /* NUMBER fields only: whole numbers. */
  integer?: boolean;
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

/* Multi-line text. */
export interface TextareaConfig {
  placeholder: string;
  defaultValue: string;
}

/* A number is stored and submitted as its decimal text, or "". */
export interface NumberConfig {
  placeholder: string;
  defaultValue: string;
}

/* Single choice shown as radio buttons. */
export interface RadioConfig {
  options: DropdownOption[];
  defaultValue: string;
}

/* Any number of choices; the value is the list of chosen option values. */
export interface MultiSelectConfig {
  options: DropdownOption[];
  defaultValue: string[];
}

/* 1..max stars; defaultValue 0 means no default rating. */
export interface RatingConfig {
  max: number;
  defaultValue: number;
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
export type TextareaFieldDefinition = BaseFieldDefinition<"TEXTAREA", TextareaConfig>;
export type NumberFieldDefinition = BaseFieldDefinition<"NUMBER", NumberConfig>;
export type PhoneFieldDefinition = BaseFieldDefinition<"PHONE", TextConfig>;
export type UrlFieldDefinition = BaseFieldDefinition<"URL", TextConfig>;
export type RadioFieldDefinition = BaseFieldDefinition<"RADIO", RadioConfig>;
export type MultiSelectFieldDefinition = BaseFieldDefinition<"MULTI_SELECT", MultiSelectConfig>;
export type RatingFieldDefinition = BaseFieldDefinition<"RATING", RatingConfig>;

export type FormFieldDefinition =
  | TextFieldDefinition
  | EmailFieldDefinition
  | DropdownFieldDefinition
  | CheckboxFieldDefinition
  | DateFieldDefinition
  | TextareaFieldDefinition
  | NumberFieldDefinition
  | PhoneFieldDefinition
  | UrlFieldDefinition
  | RadioFieldDefinition
  | MultiSelectFieldDefinition
  | RatingFieldDefinition;

/* Maps a field type to its config / definition type. */
export interface FieldConfigByType {
  TEXT: TextConfig;
  EMAIL: EmailConfig;
  DROPDOWN: DropdownConfig;
  CHECKBOX: CheckboxConfig;
  DATE: DateConfig;
  TEXTAREA: TextareaConfig;
  NUMBER: NumberConfig;
  PHONE: TextConfig;
  URL: TextConfig;
  RADIO: RadioConfig;
  MULTI_SELECT: MultiSelectConfig;
  RATING: RatingConfig;
}

export interface FieldDefinitionByType {
  TEXT: TextFieldDefinition;
  EMAIL: EmailFieldDefinition;
  DROPDOWN: DropdownFieldDefinition;
  CHECKBOX: CheckboxFieldDefinition;
  DATE: DateFieldDefinition;
  TEXTAREA: TextareaFieldDefinition;
  NUMBER: NumberFieldDefinition;
  PHONE: PhoneFieldDefinition;
  URL: UrlFieldDefinition;
  RADIO: RadioFieldDefinition;
  MULTI_SELECT: MultiSelectFieldDefinition;
  RATING: RatingFieldDefinition;
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
  | "date"
  | "textarea"
  | "number"
  | "phone"
  | "url"
  | "radio"
  | "multiselect"
  | "rating";

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
