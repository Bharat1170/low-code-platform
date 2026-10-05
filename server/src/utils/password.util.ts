import argon2 from "argon2";

export const hashPassword = async (
  password: string,
): Promise<string> => {
  return argon2.hash(password);
};

export const verifyPassword = async (
  password: string,
  passwordHash: string,
): Promise<boolean> => {
  return argon2.verify(passwordHash, password);
};

/*
 * Login timing equalization. When the email is unknown there is no
 * stored hash to verify, which would make unknown accounts answer
 * measurably faster than known ones. Verifying against a throwaway hash
 * made with the same parameters keeps the cost the same. The result is
 * always discarded.
 */
let dummyPasswordHash: Promise<string> | undefined;

export const verifyPasswordAgainstDummyHash = async (
  password: string,
): Promise<void> => {
  dummyPasswordHash ??= hashPassword(
    "timing-equalization-password-never-valid",
  );

  await argon2.verify(await dummyPasswordHash, password);
};
