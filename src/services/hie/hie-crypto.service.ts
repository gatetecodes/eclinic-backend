import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { AppError } from "@/lib/app-error";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const HEX_256_PATTERN = /^[a-f\d]{64}$/i;

function configuredKey(
  environmentKey: string,
  missingCode: string,
  invalidCode: string
): Buffer {
  const raw = process.env[environmentKey]?.trim();
  if (!raw) {
    throw new AppError({
      status: 503,
      code: missingCode,
      message: `${environmentKey} is not configured`,
      exposeMessage: true,
    });
  }

  const key = HEX_256_PATTERN.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new AppError({
      status: 503,
      code: invalidCode,
      message: `${environmentKey} must contain exactly 32 bytes`,
      exposeMessage: true,
    });
  }
  return key;
}

function encryptionKey(): Buffer {
  return configuredKey(
    "HIE_DATA_ENCRYPTION_KEY",
    "HIE_ENCRYPTION_NOT_CONFIGURED",
    "HIE_ENCRYPTION_KEY_INVALID"
  );
}

function identifierHashKey(): Buffer {
  return configuredKey(
    "HIE_IDENTIFIER_HASH_KEY",
    "HIE_IDENTIFIER_HASH_NOT_CONFIGURED",
    "HIE_IDENTIFIER_HASH_KEY_INVALID"
  );
}

export function assertHieEncryptionConfigured(): void {
  encryptionKey();
  identifierHashKey();
}

export function encryptHieValue(value: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

export function decryptHieValue(envelope: string): string {
  const [version, ivValue, tagValue, ciphertextValue] = envelope.split(".");
  if (version !== "v1" || !(ivValue && tagValue && ciphertextValue)) {
    throw new AppError({
      status: 500,
      code: "HIE_ENCRYPTED_VALUE_INVALID",
      message: "Stored HIE value is invalid",
    });
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    encryptionKey(),
    Buffer.from(ivValue, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function hashHieIdentifier(value: string): string {
  return createHmac("sha256", identifierHashKey())
    .update(value.trim().toUpperCase())
    .digest("hex");
}

export function encryptHieJson(value: unknown): string {
  return encryptHieValue(JSON.stringify(value));
}

export function decryptHieJson(envelope: string): unknown {
  return JSON.parse(decryptHieValue(envelope)) as unknown;
}
