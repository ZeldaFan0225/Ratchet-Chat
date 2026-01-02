import { encryptString, decryptString, type EncryptedPayload } from "./crypto"

// Base32 alphabet (RFC 4648)
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

/**
 * Generate a TOTP secret (Base32 encoded, 160 bits / 20 bytes)
 */
export function generateTotpSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return base32Encode(bytes)
}

/**
 * Base32 encode a byte array
 */
function base32Encode(data: Uint8Array): string {
  let bits = 0
  let value = 0
  let output = ""

  for (const byte of data) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  }

  return output
}

/**
 * Base32 decode a string to bytes
 */
function base32Decode(encoded: string): Uint8Array {
  const cleaned = encoded.toUpperCase().replace(/[^A-Z2-7]/g, "")

  let bits = 0
  let value = 0
  const output: number[] = []

  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char)
    if (idx === -1) continue

    value = (value << 5) | idx
    bits += 5
    while (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }

  return new Uint8Array(output)
}

/**
 * Generate a TOTP code from a secret
 * This uses HMAC-SHA1 as per RFC 6238
 */
export async function generateTotpCode(secret: string): Promise<string> {
  const key = base32Decode(secret)
  const counter = Math.floor(Date.now() / 30000)

  const counterBuffer = new ArrayBuffer(8)
  const view = new DataView(counterBuffer)
  view.setBigUint64(0, BigInt(counter), false)

  const rawKey = Uint8Array.from(key).buffer
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  )

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, counterBuffer)
  const hmac = new Uint8Array(signature)

  const offset = hmac[19] & 0xf
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)) %
    1000000

  return code.toString().padStart(6, "0")
}

/**
 * Generate a TOTP URI for QR code display
 * This URI can be scanned by authenticator apps (Google Authenticator, Authy, etc.)
 */
export function getTotpUri(
  secret: string,
  username: string,
  issuer = "Ratchet Chat"
): string {
  const encodedIssuer = encodeURIComponent(issuer)
  const encodedLabel = encodeURIComponent(`${issuer}:${username}`)
  return `otpauth://totp/${encodedLabel}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`
}

/**
 * Encrypt TOTP secret with master key for backup storage
 */
export async function encryptTotpSecret(
  masterKey: CryptoKey,
  secret: string
): Promise<EncryptedPayload> {
  return encryptString(masterKey, secret)
}

/**
 * Decrypt TOTP secret with master key
 */
export async function decryptTotpSecret(
  masterKey: CryptoKey,
  payload: EncryptedPayload
): Promise<string> {
  return decryptString(masterKey, payload)
}

/**
 * Validate TOTP code format (6 digits)
 */
export function isValidTotpCodeFormat(code: string): boolean {
  return /^\d{6}$/.test(code)
}

/**
 * Calculate time remaining until next TOTP period
 */
export function getTimeRemaining(): number {
  const now = Date.now()
  const period = 30000 // 30 seconds in ms
  return Math.ceil((period - (now % period)) / 1000)
}

/**
 * Format recovery codes for display
 * Codes come in format XXXX-XXXX
 */
export function formatRecoveryCodes(codes: string[]): string {
  return codes.join("\n")
}

/**
 * Parse recovery code input (normalize format)
 */
export function normalizeRecoveryCode(code: string): string {
  // Remove spaces and dashes, uppercase
  return code.replace(/[\s-]/g, "").toUpperCase()
}
