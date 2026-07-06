/**
 * Crypto primitives. sha256hex is the hash-not-text reference everywhere
 * (the `guard_events` contract); AES-256-GCM encrypts vaulted upstream
 * credentials at rest.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto"

import { err, ok, type Result } from "neverthrow"

export const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex")

export const newUuid = (): string => randomUUID()

/** Client-facing gateway key. Only its sha256 is ever stored. */
export const newClientKey = (): string => `sk-agw-${randomBytes(24).toString("hex")}`

export const constantTimeEq = (a: string, b: string): boolean => {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

const ENC_VERSION = "v1"

/** AES-256-GCM → "v1:<iv b64>:<tag b64>:<ciphertext b64>". */
export const encryptSecret = (plaintext: string, keyHex: string): Result<string, string> => {
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) return err("vault key must be 64 hex chars")
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv)
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return ok(`${ENC_VERSION}:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`)
}

export const decryptSecret = (blob: string, keyHex: string): Result<string, string> => {
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) return err("vault key must be 64 hex chars")
  const parts = blob.split(":")
  if (parts.length !== 4 || parts[0] !== ENC_VERSION) return err("unrecognized vault blob format")
  const [, ivB64, tagB64, ctB64] = parts
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(keyHex, "hex"),
      Buffer.from(ivB64 as string, "base64"),
    )
    decipher.setAuthTag(Buffer.from(tagB64 as string, "base64"))
    const pt = Buffer.concat([decipher.update(Buffer.from(ctB64 as string, "base64")), decipher.final()])
    return ok(pt.toString("utf8"))
  } catch {
    return err("vault decryption failed (wrong key or corrupted blob)")
  }
}
