import { createHash, randomBytes } from "crypto"
import * as OTPAuth from "otpauth"

// TOTP Configuration (RFC 6238)
const TOTP_PERIOD = 30 // 30-second window
const TOTP_DIGITS = 6
const TOTP_ALGORITHM = "SHA1" // Standard for authenticator apps
const DRIFT_TOLERANCE = 1 // Allow 1 step before/after (±30 seconds)
const SECRET_SIZE = 20 // 160 bits (standard)
const RECOVERY_CODE_COUNT = 8
const RECOVERY_CODE_LENGTH = 8

// Characters for recovery codes (no ambiguous chars: 0/O, 1/I/L)
const RECOVERY_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

/**
 * Generate a new TOTP secret (Base32 encoded, 160 bits)
 */
export function generateTotpSecret(): string {
  const secret = new OTPAuth.Secret({ size: SECRET_SIZE })
  return secret.base32
}

/**
 * Verify a TOTP code against a secret
 * Returns true if the code is valid within the drift tolerance window
 */
export function verifyTotpCode(secret: string, code: string): boolean {
  try {
    const totp = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(secret),
      period: TOTP_PERIOD,
      digits: TOTP_DIGITS,
      algorithm: TOTP_ALGORITHM,
    })

    // validate() returns null if invalid, or the time step offset if valid
    const delta = totp.validate({ token: code, window: DRIFT_TOLERANCE })
    return delta !== null
  } catch {
    return false
  }
}

/**
 * Generate a TOTP code from a secret (for testing purposes)
 */
export function generateTotpCode(secret: string): string {
  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    period: TOTP_PERIOD,
    digits: TOTP_DIGITS,
    algorithm: TOTP_ALGORITHM,
  })
  return totp.generate()
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
  const totp = new OTPAuth.TOTP({
    issuer,
    label: username,
    secret: OTPAuth.Secret.fromBase32(secret),
    period: TOTP_PERIOD,
    digits: TOTP_DIGITS,
    algorithm: TOTP_ALGORITHM,
  })

  return totp.toString()
}

/**
 * Generate recovery codes
 * Format: XXXX-XXXX (8 alphanumeric chars with hyphen for readability)
 */
export function generateRecoveryCodes(
  count: number = RECOVERY_CODE_COUNT
): string[] {
  const codes: string[] = []

  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(RECOVERY_CODE_LENGTH)
    let code = ""
    for (let j = 0; j < RECOVERY_CODE_LENGTH; j++) {
      code += RECOVERY_CODE_CHARS[bytes[j] % RECOVERY_CODE_CHARS.length]
    }
    // Format as XXXX-XXXX for readability
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`)
  }

  return codes
}

/**
 * Hash a recovery code for secure storage
 * Normalizes the code (removes hyphens, uppercases) before hashing
 */
export function hashRecoveryCode(code: string): string {
  const normalized = code.replace(/-/g, "").toUpperCase()
  return createHash("sha256").update(normalized).digest("hex")
}

/**
 * Verify a recovery code against a stored hash
 */
export function verifyRecoveryCode(code: string, hash: string): boolean {
  return hashRecoveryCode(code) === hash
}

/**
 * Validate TOTP code format (6 digits)
 */
export function isValidTotpCodeFormat(code: string): boolean {
  return /^\d{6}$/.test(code)
}

/**
 * Validate recovery code format (XXXX-XXXX or XXXXXXXX)
 */
export function isValidRecoveryCodeFormat(code: string): boolean {
  const normalized = code.replace(/-/g, "").toUpperCase()
  const validCharsRegex = new RegExp(`^[${RECOVERY_CODE_CHARS}]{8}$`)
  return validCharsRegex.test(normalized)
}
