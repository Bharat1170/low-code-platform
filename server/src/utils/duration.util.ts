const DURATION_PATTERN = /^(\d+)\s*(s|m|h|d|w)$/i;

const DURATION_MULTIPLIERS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
} as const;

export const parseDurationToMilliseconds = (
  value: string,
): number => {
  const normalizedValue = value.trim();
  const match = normalizedValue.match(DURATION_PATTERN);

  if (!match) {
    throw new Error(`Invalid duration format: ${value}`);
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase() as keyof typeof DURATION_MULTIPLIERS;

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`Invalid duration value: ${value}`);
  }

  const multiplier = DURATION_MULTIPLIERS[unit];

  if (amount > Number.MAX_SAFE_INTEGER / multiplier) {
    throw new Error(`Duration is too large: ${value}`);
  }

  return amount * multiplier;
};