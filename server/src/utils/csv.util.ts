/*
 * RFC 4180 CSV with spreadsheet formula-injection protection.
 *
 * Submitted values come from anonymous respondents, so a cell that a
 * spreadsheet would treat as a formula (=, +, -, @, tab, carriage return)
 * is prefixed with an apostrophe and shown as text instead.
 */

const FORMULA_START = /^[=+\-@\t\r]/;

export const csvCell = (value: string): string => {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;

  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export const toCsv = (rows: string[][]): string =>
  // BOM so Excel opens UTF-8 correctly; CRLF line endings per RFC 4180.
  `﻿${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
