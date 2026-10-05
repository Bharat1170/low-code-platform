/*
 * Date-only values ("YYYY-MM-DD") as plain strings, used by DATE fields.
 * They are validated without timezone or rollover surprises: "2026-02-31"
 * is rejected instead of being normalized to March. Zero-padded strings
 * compare correctly with < and >.
 *
 * The client has the same rules (client/.../utils/date-only.ts); keep the
 * two in step.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export const isValidDateOnly = (value: unknown): value is string => {
  if (typeof value !== "string") return false;

  const match = DATE_ONLY.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;

  // Day 0 of the next month is the last day of this one.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= lastDay;
};
