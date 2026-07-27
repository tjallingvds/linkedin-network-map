/**
 * At-rest encryption for third-party secrets we must store (Smartlead API
 * keys). Apollo/OpenAI keys are header-only and never persisted, but the
 * Smartlead reconciler and webhook handler run outside a user request and need
 * the key, so it lives in the DB — encrypted, never plaintext.
 *
 * AES-256-GCM. The key is derived from AUTH_SECRET (already required, >=32
 * chars) via scrypt, so no new secret to manage. Ciphertext is base64 of
 * iv(12) | authTag(16) | ciphertext.
 */
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { env } from "../env.js";

const KEY = scryptSync(env.AUTH_SECRET, "smartlead-key-v1", 32);
const IV_LEN = 12;
const TAG_LEN = 16;

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
