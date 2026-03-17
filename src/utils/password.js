import crypto from "node:crypto";
import { env } from "../config/env.js";

const SCRYPT_KEY_LENGTH = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = crypto.scryptSync(String(password || ""), salt, SCRYPT_KEY_LENGTH).toString("hex");
  return `scrypt$${salt}$${derivedKey}`;
}

export function verifyPassword(password, passwordHash) {
  const normalizedPassword = String(password || "");
  const normalizedHash = String(passwordHash || "");
  if (!normalizedHash) return false;

  if (!normalizedHash.startsWith("scrypt$")) {
    if (!env.allowLegacyPlaintextPasswords) return false;
    return normalizedPassword === normalizedHash;
  }

  const [, salt, hash] = normalizedHash.split("$");
  if (!salt || !hash) return false;
  const derivedKey = crypto.scryptSync(normalizedPassword, salt, SCRYPT_KEY_LENGTH).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(derivedKey, "hex"));
}
