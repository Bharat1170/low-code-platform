/*
 * Date-only values ("YYYY-MM-DD") as plain strings. They are never turned
 * into Date objects for storage, and are checked without timezone or
 * rollover surprises: "2026-02-31" is rejected rather than becoming March.
 * Because the format is zero-padded, string comparison orders dates
 * correctly.
 *
 * The server has the same rules (server/src/utils/date-only.util.ts); keep
 * the two in step.
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
