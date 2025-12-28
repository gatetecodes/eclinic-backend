import { randomBytes, scryptSync } from "node:crypto";
/**
 * Hash a password using Better Auth compatible scrypt
 * @param password - The password to hash
 * @returns The hashed password in the format `${saltHex}:${keyHex}`
 */

export const hashCredentialPassword = (password: string): string => {
  if (
    !password ||
    typeof password !== "string" ||
    password.trim().length === 0
  ) {
    throw new Error("Password must be a non-empty string");
  }
  const SALT_LENGTH = 16;
  const DERIVED_KEY_LENGTH = 64;
  const N = 16_384;
  const r = 16;
  const p = 1;
  const SCRYPT_MAXMEM_BASE = 128;
  const SCRYPT_MAXMEM_FACTOR = 2;
  const maxmem = SCRYPT_MAXMEM_BASE * N * r * SCRYPT_MAXMEM_FACTOR;

  const dkLen = DERIVED_KEY_LENGTH;
  const saltHex = randomBytes(SALT_LENGTH).toString("hex");
  const key = scryptSync(password.normalize("NFKC"), saltHex, dkLen, {
    N,
    r,
    p,
    maxmem,
  });
  return `${saltHex}:${key.toString("hex")}`;
};
