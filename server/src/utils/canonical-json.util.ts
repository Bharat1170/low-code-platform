/*
 * Deterministic JSON text for plain data: object keys are sorted, so two
 * values that are equal as data produce the same string regardless of key
 * order. Used to detect an unchanged schema. Never evaluates anything.
 */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);

    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
};
