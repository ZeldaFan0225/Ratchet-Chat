import nacl from "tweetnacl"

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const MESSAGE_SIGNATURE_PREFIX = "ratchet-chat:message:v1"

type WebCryptoWithSubtle = Crypto & { subtle: SubtleCrypto }

const buildWebCryptoError = () => {
  const isSecure =
    typeof globalThis.isSecureContext === "boolean" && globalThis.isSecureContext
  if (!isSecure) {
    return new Error(
      "WebCrypto requires a secure context. Use https or access via localhost (LAN IPs over http are not secure)."
    )
  }
  return new Error("WebCrypto is unavailable in this browser.")
}

const getWebCrypto = (): WebCryptoWithSubtle => {
  const cryptoRef = globalThis.crypto
  if (!cryptoRef?.subtle) {
    throw buildWebCryptoError()
  }
  return cryptoRef as WebCryptoWithSubtle
}

export const getSubtleCrypto = (): SubtleCrypto => getWebCrypto().subtle

export type EncryptedPayload = {
  ciphertext: string
  iv: string
}

export type IdentityKeyPair = {
  publicKey: string
  privateKey: Uint8Array
}

export type TransportKeyPair = {
  publicKey: string
  privateKey: CryptoKey
}

export type TransitEnvelope = {
  wrapped_key: string
  iv: string
  ciphertext: string
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buffer))
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  return base64ToBytes(base64).buffer
}

export function encodeUtf8(value: string): Uint8Array {
  return textEncoder.encode(value)
}

export function decodeUtf8(value: Uint8Array): string {
  return textDecoder.decode(value)
}

export function buildMessageSignaturePayload(
  senderHandle: string,
  content: string,
  messageId?: string
): Uint8Array {
  const payload = messageId
    ? [MESSAGE_SIGNATURE_PREFIX, senderHandle, content, messageId]
    : [MESSAGE_SIGNATURE_PREFIX, senderHandle, content]
  return encodeUtf8(
    JSON.stringify(payload)
  )
}

export function generateSalt(length = 16): Uint8Array {
  return getWebCrypto().getRandomValues(new Uint8Array(length))
}

export async function deriveMasterKey(
  password: string,
  salt: Uint8Array,
  iterations = 310_000
): Promise<CryptoKey> {
  const subtle = getSubtleCrypto()
  const baseKey = await subtle.importKey(
    "raw",
    textEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  )
  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    {
      name: "AES-GCM",
      length: 256,
    },
    true,
    ["encrypt", "decrypt"]
  )
}

export async function deriveAuthHash(
  password: string,
  salt: Uint8Array,
  iterations = 200_000
): Promise<string> {
  const subtle = getSubtleCrypto()
  const baseKey = await subtle.importKey(
    "raw",
    textEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  )
  const bits = await subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    256
  )
  return arrayBufferToBase64(bits)
}

export async function generateIdentityKeyPair(): Promise<IdentityKeyPair> {
  const pair = nacl.sign.keyPair()
  return {
    publicKey: bytesToBase64(pair.publicKey),
    privateKey: pair.secretKey,
  }
}

export async function generateTransportKeyPair(): Promise<TransportKeyPair> {
  const subtle = getSubtleCrypto()
  const pair = await subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"]
  )
  const publicKey = await subtle.exportKey("spki", pair.publicKey)
  return {
    publicKey: arrayBufferToBase64(publicKey),
    privateKey: pair.privateKey,
  }
}

export function getIdentityPublicKey(privateKey: Uint8Array): string {
  const pair = nacl.sign.keyPair.fromSecretKey(privateKey)
  return bytesToBase64(pair.publicKey)
}

export async function importTransportPublicKey(
  publicKeyBase64: string
): Promise<CryptoKey> {
  return getSubtleCrypto().importKey(
    "spki",
    base64ToArrayBuffer(publicKeyBase64),
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    true,
    ["encrypt"]
  )
}

export async function exportTransportPrivateKey(
  privateKey: CryptoKey
): Promise<Uint8Array> {
  const pkcs8 = await getSubtleCrypto().exportKey("pkcs8", privateKey)
  return new Uint8Array(pkcs8)
}

export async function importTransportPrivateKey(
  privateKeyBytes: Uint8Array
): Promise<CryptoKey> {
  return getSubtleCrypto().importKey(
    "pkcs8",
    privateKeyBytes,
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    true,
    ["decrypt"]
  )
}

export async function encryptBytes(
  key: CryptoKey,
  plaintext: Uint8Array
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const cryptoRef = getWebCrypto()
  const iv = cryptoRef.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(
    await cryptoRef.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext)
  )
  return { ciphertext, iv }
}

export async function decryptBytes(
  key: CryptoKey,
  ciphertext: Uint8Array,
  iv: Uint8Array
): Promise<Uint8Array> {
  const plaintext = await getSubtleCrypto().decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  )
  return new Uint8Array(plaintext)
}

export function signMessage(message: Uint8Array, privateKey: Uint8Array): string {
  return bytesToBase64(nacl.sign.detached(message, privateKey))
}

export async function encryptString(
  key: CryptoKey,
  plaintext: string
): Promise<EncryptedPayload> {
  const { ciphertext, iv } = await encryptBytes(key, textEncoder.encode(plaintext))
  return {
    ciphertext: bytesToBase64(ciphertext),
    iv: bytesToBase64(iv),
  }
}

export async function decryptString(
  key: CryptoKey,
  payload: EncryptedPayload
): Promise<string> {
  const plaintext = await decryptBytes(
    key,
    base64ToBytes(payload.ciphertext),
    base64ToBytes(payload.iv)
  )
  return textDecoder.decode(plaintext)
}

export async function encryptPrivateKey(
  masterKey: CryptoKey,
  privateKey: Uint8Array
): Promise<EncryptedPayload> {
  const { ciphertext, iv } = await encryptBytes(masterKey, privateKey)
  return {
    ciphertext: bytesToBase64(ciphertext),
    iv: bytesToBase64(iv),
  }
}

export async function decryptPrivateKey(
  masterKey: CryptoKey,
  payload: EncryptedPayload
): Promise<Uint8Array> {
  return decryptBytes(
    masterKey,
    base64ToBytes(payload.ciphertext),
    base64ToBytes(payload.iv)
  )
}

export async function encryptTransitEnvelope(
  payload: string,
  recipientPublicKey: string
): Promise<string> {
  const cryptoRef = getWebCrypto()
  const transportPublicKey = await importTransportPublicKey(recipientPublicKey)
  const aesKeyBytes = cryptoRef.getRandomValues(new Uint8Array(32))
  const aesKey = await cryptoRef.subtle.importKey(
    "raw",
    aesKeyBytes,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"]
  )
  const { ciphertext, iv } = await encryptBytes(
    aesKey,
    textEncoder.encode(payload)
  )
  const wrappedKey = await cryptoRef.subtle.encrypt(
    { name: "RSA-OAEP" },
    transportPublicKey,
    aesKeyBytes
  )
  const envelope: TransitEnvelope = {
    wrapped_key: arrayBufferToBase64(wrappedKey),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  }
  return JSON.stringify(envelope)
}

export async function decryptTransitBlob(
  encryptedBlob: string,
  transportPrivateKey: CryptoKey
): Promise<Uint8Array> {
  const subtle = getSubtleCrypto()
  let envelope: TransitEnvelope | null = null
  try {
    envelope = JSON.parse(encryptedBlob) as TransitEnvelope
  } catch {
    envelope = null
  }

  if (!envelope?.wrapped_key) {
    const decrypted = await subtle.decrypt(
      { name: "RSA-OAEP" },
      transportPrivateKey,
      base64ToArrayBuffer(encryptedBlob)
    )
    return new Uint8Array(decrypted)
  }

  const wrappedKey = base64ToArrayBuffer(envelope.wrapped_key)
  const aesKeyBytes = await subtle.decrypt(
    { name: "RSA-OAEP" },
    transportPrivateKey,
    wrappedKey
  )
  const aesKey = await subtle.importKey(
    "raw",
    aesKeyBytes,
    "AES-GCM",
    false,
    ["decrypt"]
  )
  return decryptBytes(
    aesKey,
    base64ToBytes(envelope.ciphertext),
    base64ToBytes(envelope.iv)
  )
}

export function verifySignature(
  message: Uint8Array,
  signature: string,
  publicKey: string
): boolean {
  return nacl.sign.detached.verify(
    message,
    base64ToBytes(signature),
    base64ToBytes(publicKey)
  )
}
