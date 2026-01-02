"use client"

import * as React from "react"

import { apiFetch, setAuthToken, setUnauthorizedHandler } from "@/lib/api"
import { db } from "@/lib/db"
import {
  base64ToArrayBuffer,
  base64ToBytes,
  bytesToBase64,
  buildMessageSignaturePayload,
  decryptPrivateKey,
  deriveMasterKey,
  encryptTransitEnvelope,
  encryptPrivateKey,
  getSubtleCrypto,
  generateIdentityKeyPair,
  generateSalt,
  generateTransportKeyPair,
  identitySecretKeyLength,
  transportSecretKeyLength,
  signMessage,
  type EncryptedPayload,
} from "@/lib/crypto"
import { getInstanceHost, normalizeHandle, splitHandle } from "@/lib/handles"
import { decodeContactRecord } from "@/lib/messageUtils"
import { isInCall } from "@/lib/callState"
import {
  registerServiceWorker,
  unregisterServiceWorker,
  subscribeToPush,
  unsubscribeFromPush,
  storeTransportKeyForSW,
  clearTransportKeyForSW,
  setupPushDecryptionHandler,
  setupNotificationClickHandler,
} from "@/lib/push"
import {
  loginFinish,
  loginStart,
  registerFinish,
  registerStart,
} from "@/lib/opaque"
import {
  generateTotpSecret,
  getTotpUri,
  encryptTotpSecret,
  normalizeRecoveryCode,
} from "@/lib/totp"
import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser"
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser"
import type { Contact, DirectoryEntry } from "@/types/dashboard"

type StoredKeys = {
  username: string
  handle: string
  kdfSalt: string
  kdfIterations: number
  identityPrivateKey: EncryptedPayload
  transportPrivateKey: EncryptedPayload
  publicIdentityKey: string
  publicTransportKey: string
  token: string
  // If true, master key is stored in IndexedDB for auto-unlock
  savePassword?: boolean
}

export type PasskeyInfo = {
  id: string
  credentialId: string
  name: string | null
  createdAt: string
  lastUsedAt: string
}

export type TransportKeyRotationPayload = {
  public_transport_key: string
  encrypted_transport_key: string
  encrypted_transport_iv: string
  rotated_at?: number
  timestamp?: string
}

export type SessionInfo = {
  id: string
  deviceInfo: string | null
  ipAddress: string | null
  createdAt: string
  lastActiveAt: string
  expiresAt: string
  isCurrent: boolean
}

// Server capabilities for password+2FA
export type AuthCapabilities = {
  passkey: boolean
  password_2fa: boolean
}

// Auth methods enabled for current user
export type AuthMethods = {
  has_passkey: boolean
  has_password_2fa: boolean
  passkey_count: number
}

// Pending password login state (after password verified, before TOTP)
type PendingPasswordLogin = {
  username: string
  handle: string
  sessionTicket: string
  kdfSalt: string
  kdfIterations: number
}

type AuthContextValue = {
  status: "loading" | "guest" | "locked" | "authenticated" | "awaiting_2fa" | "awaiting_master_password"
  user: { id: string | null; username: string; handle: string } | null
  token: string | null
  masterKey: CryptoKey | null
  identityPrivateKey: Uint8Array | null
  publicIdentityKey: string | null
  transportPrivateKey: Uint8Array | null
  publicTransportKey: string | null
  // Server capabilities
  capabilities: AuthCapabilities | null
  // Passkey-based registration (requires passkey + password)
  register: (username: string, password: string, savePassword?: boolean) => Promise<void>
  // Passkey-based login (no password required, optional username hint)
  loginWithPasskey: () => Promise<void>
  // Unlock with password (when in locked state)
  unlock: (password: string, savePassword?: boolean) => Promise<void>
  deleteAccount: () => Promise<void>
  logout: () => void
  fetchSessions: () => Promise<SessionInfo[]>
  invalidateSession: (sessionId: string) => Promise<void>
  invalidateAllOtherSessions: () => Promise<number>
  rotateTransportKey: () => Promise<void>
  applyTransportKeyRotation: (payload: TransportKeyRotationPayload) => Promise<void>
  getTransportKeyRotatedAt: () => Promise<number | null>
  // Passkey management (requires authenticated + unlocked state)
  fetchPasskeys: () => Promise<PasskeyInfo[]>
  addPasskey: (name?: string) => Promise<PasskeyInfo>
  removePasskey: (credentialId: string) => Promise<void>
  // Password + 2FA authentication
  registerWithPassword: (
    username: string,
    accountPassword: string,
    masterPassword: string,
    savePassword?: boolean
  ) => Promise<{ totpSecret: string; totpUri: string; onVerify: (totpCode: string) => Promise<string[]> }>
  loginWithPassword: (username: string, accountPassword: string) => Promise<void>
  verifyTotp: (code: string) => Promise<void>
  verifyRecoveryCode: (code: string) => Promise<{ remainingCodes: number }>
  unlockAfter2FA: (masterPassword: string, savePassword?: boolean) => Promise<void>
  cancelPasswordLogin: () => void
  // Auth method management
  fetchAuthMethods: () => Promise<AuthMethods>
  addPasswordAuth: (
    accountPassword: string,
    masterPassword: string
  ) => Promise<{ totpSecret: string; totpUri: string; onVerify: (totpCode: string) => Promise<string[]> }>
  removePasswordAuth: () => Promise<void>
  regenerateTotp: () => Promise<{ totpSecret: string; totpUri: string; onVerify: (totpCode: string) => Promise<string[]> }>
  regenerateRecoveryCodes: () => Promise<string[]>
  changeAccountPassword: (currentPassword: string, newPassword: string) => Promise<void>
}

const ACTIVE_SESSION_KEY = "active_session"
const TRANSPORT_KEY_ROTATED_AT_KEY = "transportKeyRotatedAt"
const TRANSPORT_KEY_ROTATION_MS = 30 * 24 * 60 * 60 * 1000
const LAST_SELECTED_CHAT_KEY = "lastSelectedChat"

const AuthContext = React.createContext<AuthContextValue | undefined>(undefined)

function resolveLocalUser(input: string) {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error("Username is required")
  }
  const instanceHost = getInstanceHost()
  if (trimmed.includes("@")) {
    const parts = splitHandle(trimmed)
    if (!parts) {
      throw new Error("Enter a valid local handle")
    }
    if (instanceHost && parts.host !== instanceHost) {
      throw new Error("Login is only supported for local users")
    }
    return { username: parts.username, handle: parts.handle }
  }
  const handle = normalizeHandle(trimmed)
  const parts = splitHandle(handle)
  if (!parts) {
    throw new Error("Instance host is not configured")
  }
  if (instanceHost && parts.host !== instanceHost) {
    throw new Error("Login is only supported for local users")
  }
  return { username: parts.username, handle: parts.handle }
}

function decodeJwtSubject(token: string): string | null {
  const parts = token.split(".")
  if (parts.length < 2) {
    return null
  }
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=")
    const json = atob(padded)
    const payload = JSON.parse(json) as { sub?: string }
    return typeof payload.sub === "string" ? payload.sub : null
  } catch {
    return null
  }
}

async function exportMasterKey(key: CryptoKey) {
  const raw = await getSubtleCrypto().exportKey("raw", key)
  return bytesToBase64(new Uint8Array(raw))
}

async function importMasterKey(rawBase64: string) {
  return getSubtleCrypto().importKey(
    "raw",
    base64ToArrayBuffer(rawBase64),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"]
  )
}

async function loadActiveSession(): Promise<StoredKeys | null> {
  const record = await db.auth.get(ACTIVE_SESSION_KEY)
  if (!record || !record.data) {
    return null
  }
  return record.data as StoredKeys
}

async function persistActiveSession(keys: StoredKeys) {
  await db.auth.put({ username: ACTIVE_SESSION_KEY, data: keys })
}

async function updateActiveSession(patch: Partial<StoredKeys>) {
  const current = await loadActiveSession()
  if (!current) {
    return
  }
  await persistActiveSession({ ...current, ...patch })
}

async function getTransportKeyRotatedAt(): Promise<number | null> {
  const record = await db.syncState.get(TRANSPORT_KEY_ROTATED_AT_KEY)
  const value = record?.value
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

async function setTransportKeyRotatedAt(timestamp: number) {
  await db.syncState.put({
    key: TRANSPORT_KEY_ROTATED_AT_KEY,
    value: timestamp,
  })
}

async function clearStaleData() {
  if (typeof window !== "undefined") {
    window.localStorage.clear()
    window.sessionStorage.clear()
  }
  try {
    await db.delete()
    await db.open()
  } catch {
    // Ignore errors during cleanup
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<"loading" | "guest" | "locked" | "authenticated" | "awaiting_2fa" | "awaiting_master_password">("loading")
  const [token, setToken] = React.useState<string | null>(null)
  const [user, setUser] = React.useState<{
    id: string | null
    username: string
    handle: string
  } | null>(null)
  const [masterKey, setMasterKey] = React.useState<CryptoKey | null>(null)
  const [identityPrivateKey, setIdentityPrivateKey] =
    React.useState<Uint8Array | null>(null)
  const [publicIdentityKey, setPublicIdentityKey] =
    React.useState<string | null>(null)
  const [transportPrivateKey, setTransportPrivateKey] =
    React.useState<Uint8Array | null>(null)
  const [publicTransportKey, setPublicTransportKey] =
    React.useState<string | null>(null)
  const [capabilities, setCapabilities] = React.useState<AuthCapabilities | null>(null)
  const [pendingPasswordLogin, setPendingPasswordLogin] = React.useState<PendingPasswordLogin | null>(null)
  // Store encrypted keys temporarily during 2FA flow
  const [pendingKeys, setPendingKeys] = React.useState<{
    encrypted_identity_key: string
    encrypted_identity_iv: string
    encrypted_transport_key: string
    encrypted_transport_iv: string
    public_identity_key: string
    public_transport_key: string
  } | null>(null)

  const clearSession = React.useCallback(async (callLogoutApi = true) => {
    // Clear state FIRST so UI updates immediately
    setStatus("guest")
    setUser(null)
    setMasterKey(null)
    setIdentityPrivateKey(null)
    setPublicIdentityKey(null)
    setTransportPrivateKey(null)
    setPublicTransportKey(null)
    setPendingPasswordLogin(null)
    setPendingKeys(null)

    const currentToken = token
    setToken(null)
    setAuthToken(null)

    if (typeof window !== "undefined") {
      window.localStorage.clear()
      window.sessionStorage.clear()
    }

    // Best-effort cleanup (don't block on these)
    void (async () => {
      // Unsubscribe from push BEFORE invalidating the token
      if (callLogoutApi && currentToken) {
        try {
          await unsubscribeFromPush()
        } catch {
          // Best-effort
        }

        try {
          await apiFetch("/auth/sessions/current", { method: "DELETE" })
        } catch {
          try {
            await apiFetch("/auth/logout", { method: "POST" })
          } catch {
            // Best-effort logout
          }
        }
      }

      // Clear master key from IndexedDB before full delete
      try {
        await db.syncState.delete("masterKey")
        await db.syncState.delete(LAST_SELECTED_CHAT_KEY)
      } catch {
        // Best-effort
      }

      // Clear local push data and unregister service worker
      try {
        await clearTransportKeyForSW()
        await unregisterServiceWorker()
      } catch {
        // Best-effort
      }

      void db.delete().then(() => db.open()).catch(() => {})
    })()
  }, [token])

  React.useEffect(() => {
    setUnauthorizedHandler(() => clearSession())
    return () => setUnauthorizedHandler(null)
  }, [clearSession])

  React.useEffect(() => {
    const restore = async () => {
      try {
        const session = await loadActiveSession()
        if (!session) {
          // No session found - clear any stale data and go to guest
          await clearStaleData()
          setStatus("guest")
          return
        }

        const userId = decodeJwtSubject(session.token)
        setAuthToken(session.token)
        setToken(session.token)
        setUser({
          id: userId,
          username: session.username,
          handle: session.handle,
        })
        setPublicIdentityKey(session.publicIdentityKey)
        setPublicTransportKey(session.publicTransportKey)

        // Load master key from IndexedDB (only if savePassword was true)
        const masterKeyRecord = await db.syncState.get("masterKey")
        const masterKeyJson = masterKeyRecord?.value as string | undefined
        if (!masterKeyJson) {
          // Session exists but master key not saved - go to locked state
          setStatus("locked")
          return
        }
        const masterKey = await importMasterKey(masterKeyJson)

        const identityPrivateKey = await decryptPrivateKey(
          masterKey,
          session.identityPrivateKey
        )
        const transportPrivateKey = await decryptPrivateKey(
          masterKey,
          session.transportPrivateKey
        )

        if (
          identityPrivateKey.length !== identitySecretKeyLength ||
          transportPrivateKey.length !== transportSecretKeyLength
        ) {
          // Keys are invalid - go to locked to re-derive
          setStatus("locked")
          return
        }

        // Ensure transport key is stored for service worker (in case it was missing)
        await storeTransportKeyForSW(transportPrivateKey)

        setMasterKey(masterKey)
        setIdentityPrivateKey(identityPrivateKey)
        setTransportPrivateKey(transportPrivateKey)
        setStatus("authenticated")
      } catch {
        // Restoration failed - try to go to locked if we have a session
        const session = await loadActiveSession().catch(() => null)
        if (session) {
          const userId = decodeJwtSubject(session.token)
          setAuthToken(session.token)
          setToken(session.token)
          setUser({
            id: userId,
            username: session.username,
            handle: session.handle,
          })
          setPublicIdentityKey(session.publicIdentityKey)
          setPublicTransportKey(session.publicTransportKey)
          setStatus("locked")
        } else {
          await clearStaleData()
          setStatus("guest")
        }
      }
    }
    void restore()
  }, [])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await apiFetch<AuthCapabilities>("/auth/capabilities")
        if (!cancelled) {
          setCapabilities(data)
        }
      } catch {
        if (!cancelled) {
          setCapabilities(null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const performOpaqueLogin = React.useCallback(
    async (
      username: string,
      handle: string,
      password: string,
      paramsOverride?: { kdf_salt: string; kdf_iterations: number }
    ) => {
      const params =
        paramsOverride ??
        (await apiFetch<{
          kdf_salt: string
          kdf_iterations: number
        }>(`/auth/params/${encodeURIComponent(username)}`))
      const masterKey = await deriveMasterKey(
        password,
        base64ToBytes(params.kdf_salt),
        params.kdf_iterations
      )
      const loginStartState = await loginStart(password)
      const startResponse = await apiFetch<{ response: string }>(
        "/auth/opaque/login/start",
        {
          method: "POST",
          body: {
            username,
            request: bytesToBase64(loginStartState.request),
          },
        }
      )
      const loginFinishState = await loginFinish(
        loginStartState.state,
        base64ToBytes(startResponse.response)
      )
      const loginResponse = await apiFetch<{
        token: string
        keys: {
          encrypted_identity_key: string
          encrypted_identity_iv: string
          encrypted_transport_key: string
          encrypted_transport_iv: string
          kdf_salt: string
          kdf_iterations: number
          public_identity_key: string
          public_transport_key: string
        }
      }>("/auth/opaque/login/finish", {
        method: "POST",
        body: {
          username,
          finish: bytesToBase64(loginFinishState.finishMessage),
        },
      })

      const identityPrivateKey = await decryptPrivateKey(
        masterKey,
        {
          ciphertext: loginResponse.keys.encrypted_identity_key,
          iv: loginResponse.keys.encrypted_identity_iv,
        }
      )
      const transportPrivateKey = await decryptPrivateKey(
        masterKey,
        {
          ciphertext: loginResponse.keys.encrypted_transport_key,
          iv: loginResponse.keys.encrypted_transport_iv,
        }
      )
      if (
        identityPrivateKey.length !== identitySecretKeyLength ||
        transportPrivateKey.length !== transportSecretKeyLength
      ) {
        throw new Error("Stored keys are not post-quantum compatible")
      }

      setAuthToken(loginResponse.token)

      const userId = decodeJwtSubject(loginResponse.token)
      await persistActiveSession({
        username,
        handle,
        kdfSalt: params.kdf_salt,
        kdfIterations: params.kdf_iterations,
        identityPrivateKey: {
          ciphertext: loginResponse.keys.encrypted_identity_key,
          iv: loginResponse.keys.encrypted_identity_iv,
        },
        transportPrivateKey: {
          ciphertext: loginResponse.keys.encrypted_transport_key,
          iv: loginResponse.keys.encrypted_transport_iv,
        },
        publicIdentityKey: loginResponse.keys.public_identity_key,
        publicTransportKey: loginResponse.keys.public_transport_key,
        token: loginResponse.token,
      })

      // Store master key in IndexedDB for persistent sessions
      await db.syncState.put({
        key: "masterKey",
        value: await exportMasterKey(masterKey),
      })

      setStatus("authenticated")
      setToken(loginResponse.token)
      setUser({ id: userId, username, handle })
      setMasterKey(masterKey)
      setIdentityPrivateKey(identityPrivateKey)
      setPublicIdentityKey(loginResponse.keys.public_identity_key)
      setTransportPrivateKey(transportPrivateKey)
      setPublicTransportKey(loginResponse.keys.public_transport_key)
    },
    []
  )

  const register = React.useCallback(
    async (usernameInput: string, password: string, savePassword = false) => {
      const { username, handle } = resolveLocalUser(usernameInput)
      const kdfSalt = generateSalt()
      const kdfIterations = 310_000
      const masterKey = await deriveMasterKey(password, kdfSalt, kdfIterations)

      const identityPair = await generateIdentityKeyPair()
      const transportPair = await generateTransportKeyPair()

      const encryptedIdentity = await encryptPrivateKey(
        masterKey,
        identityPair.privateKey
      )
      const encryptedTransport = await encryptPrivateKey(
        masterKey,
        transportPair.privateKey
      )

      // Start combined passkey + OPAQUE registration
      const opaqueStart = await registerStart(password)
      const startResponse = await apiFetch<{
        opaque_response: string
        passkey_options: PublicKeyCredentialCreationOptionsJSON
      }>("/auth/passkey/register/start", {
        method: "POST",
        body: {
          username,
          opaque_request: bytesToBase64(opaqueStart.request),
        },
      })

      // Create passkey
      const passkeyResponse = await startRegistration({
        optionsJSON: startResponse.passkey_options,
      })

      // Finish OPAQUE registration
      const opaqueFinish = await registerFinish(
        opaqueStart.state,
        base64ToBytes(startResponse.opaque_response)
      )

      // Complete registration with both passkey and OPAQUE
      const finishResponse = await apiFetch<{
        token: string
        user: { id: string; username: string }
        keys: {
          encrypted_identity_key: string
          encrypted_identity_iv: string
          encrypted_transport_key: string
          encrypted_transport_iv: string
          kdf_salt: string
          kdf_iterations: number
          public_identity_key: string
          public_transport_key: string
        }
      }>("/auth/passkey/register/finish", {
        method: "POST",
        body: {
          username,
          opaque_finish: bytesToBase64(opaqueFinish),
          passkey_response: passkeyResponse,
          kdf_salt: bytesToBase64(kdfSalt),
          kdf_iterations: kdfIterations,
          public_identity_key: identityPair.publicKey,
          public_transport_key: transportPair.publicKey,
          encrypted_identity_key: encryptedIdentity.ciphertext,
          encrypted_identity_iv: encryptedIdentity.iv,
          encrypted_transport_key: encryptedTransport.ciphertext,
          encrypted_transport_iv: encryptedTransport.iv,
        },
      })

      // Store session
      setAuthToken(finishResponse.token)
      await persistActiveSession({
        username,
        handle,
        kdfSalt: bytesToBase64(kdfSalt),
        kdfIterations,
        identityPrivateKey: encryptedIdentity,
        transportPrivateKey: encryptedTransport,
        publicIdentityKey: identityPair.publicKey,
        publicTransportKey: transportPair.publicKey,
        token: finishResponse.token,
        savePassword,
      })

      // Only store master key if savePassword is true
      if (savePassword) {
        await db.syncState.put({
          key: "masterKey",
          value: await exportMasterKey(masterKey),
        })
        // Store transport key for service worker push decryption
        await storeTransportKeyForSW(transportPair.privateKey)
      }

      setStatus("authenticated")
      setToken(finishResponse.token)
      setUser({ id: finishResponse.user.id, username, handle })
      setMasterKey(masterKey)
      setIdentityPrivateKey(identityPair.privateKey)
      setPublicIdentityKey(identityPair.publicKey)
      setTransportPrivateKey(transportPair.privateKey)
      setPublicTransportKey(transportPair.publicKey)
    },
    []
  )

  const loginWithPasskey = React.useCallback(async () => {
    // Get passkey login options for discoverable credentials
    const options = await apiFetch<PublicKeyCredentialRequestOptionsJSON>(
      "/auth/passkey/login/options",
      { method: "POST", body: {} }
    )

    // Authenticate with passkey
    const authResponse = await startAuthentication({ optionsJSON: options })

    // Finish login
    const loginResponse = await apiFetch<{
      token: string
      user: { id: string; username: string }
      keys: {
        encrypted_identity_key: string
        encrypted_identity_iv: string
        encrypted_transport_key: string
        encrypted_transport_iv: string
        kdf_salt: string
        kdf_iterations: number
        public_identity_key: string
        public_transport_key: string
      }
    }>("/auth/passkey/login/finish", {
      method: "POST",
      body: { response: authResponse },
    })

    const instanceHost = getInstanceHost()
    const handle = `${loginResponse.user.username}@${instanceHost}`
    const userId = loginResponse.user.id

    setAuthToken(loginResponse.token)
    await persistActiveSession({
      username: loginResponse.user.username,
      handle,
      kdfSalt: loginResponse.keys.kdf_salt,
      kdfIterations: loginResponse.keys.kdf_iterations,
      identityPrivateKey: {
        ciphertext: loginResponse.keys.encrypted_identity_key,
        iv: loginResponse.keys.encrypted_identity_iv,
      },
      transportPrivateKey: {
        ciphertext: loginResponse.keys.encrypted_transport_key,
        iv: loginResponse.keys.encrypted_transport_iv,
      },
      publicIdentityKey: loginResponse.keys.public_identity_key,
      publicTransportKey: loginResponse.keys.public_transport_key,
      token: loginResponse.token,
      savePassword: false,
    })

    // Go to locked state - user needs to enter password to unlock
    setToken(loginResponse.token)
    setUser({ id: userId, username: loginResponse.user.username, handle })
    setPublicIdentityKey(loginResponse.keys.public_identity_key)
    setPublicTransportKey(loginResponse.keys.public_transport_key)
    setStatus("locked")
  }, [])

  const unlock = React.useCallback(
    async (password: string, savePassword = false) => {
      const session = await loadActiveSession()
      if (!session) {
        throw new Error("No session to unlock")
      }

      // Derive master key from password
      const masterKey = await deriveMasterKey(
        password,
        base64ToBytes(session.kdfSalt),
        session.kdfIterations
      )

      // Verify password via OPAQUE unlock
      const unlockStart = await loginStart(password)
      const startResponse = await apiFetch<{ response: string }>(
        "/auth/opaque/unlock/start",
        {
          method: "POST",
          body: { request: bytesToBase64(unlockStart.request) },
        }
      )
      const unlockFinishState = await loginFinish(
        unlockStart.state,
        base64ToBytes(startResponse.response)
      )
      await apiFetch("/auth/opaque/unlock/finish", {
        method: "POST",
        body: { finish: bytesToBase64(unlockFinishState.finishMessage) },
      })

      // Decrypt private keys
      const identityPrivateKey = await decryptPrivateKey(
        masterKey,
        session.identityPrivateKey
      )
      const transportPrivateKey = await decryptPrivateKey(
        masterKey,
        session.transportPrivateKey
      )

      if (
        identityPrivateKey.length !== identitySecretKeyLength ||
        transportPrivateKey.length !== transportSecretKeyLength
      ) {
        throw new Error("Invalid key material")
      }

      // Store master key if savePassword is true
      if (savePassword) {
        await db.syncState.put({
          key: "masterKey",
          value: await exportMasterKey(masterKey),
        })
        await updateActiveSession({ savePassword: true })
        // Store transport key for service worker push decryption
        await storeTransportKeyForSW(transportPrivateKey)
      } else {
        // Clear transport key if not saving password (SW can't decrypt)
        await clearTransportKeyForSW()
      }

      setMasterKey(masterKey)
      setIdentityPrivateKey(identityPrivateKey)
      setTransportPrivateKey(transportPrivateKey)
      setStatus("authenticated")
    },
    []
  )

  const deleteAccount = React.useCallback(async () => {
    await apiFetch("/auth/account", { method: "DELETE" })
    await clearSession(false) // Don't call logout API, account is already deleted
  }, [clearSession])

  const notifyContactsOfTransportKeyRotation = React.useCallback(
    async (publicTransportKey: string, rotatedAt: number) => {
      if (!masterKey || !identityPrivateKey || !publicIdentityKey || !user?.handle) {
        return
      }
      const ownerId = user.id ?? user.handle
      const records = await db.contacts
        .where("ownerId")
        .equals(ownerId)
        .toArray()
      const decoded = await Promise.all(
        records.map((record) => decodeContactRecord(record, masterKey))
      )
      const contacts = decoded.filter(Boolean) as Contact[]
      if (contacts.length === 0) {
        return
      }
      const signatureBody = `key-rotation:${rotatedAt}:${publicTransportKey}`
      const signature = signMessage(
        buildMessageSignaturePayload(user.handle, signatureBody),
        identityPrivateKey
      )
      const payload = JSON.stringify({
        type: "key_rotation",
        content: signatureBody,
        rotated_at: rotatedAt,
        public_transport_key: publicTransportKey,
        sender_handle: user.handle,
        sender_signature: signature,
        sender_identity_key: publicIdentityKey,
      })

      for (const contact of contacts) {
        if (!contact.handle || contact.handle === user.handle) {
          continue
        }
        let recipientTransportKey = contact.publicTransportKey
        if (!recipientTransportKey) {
          try {
            const entry = await apiFetch<DirectoryEntry>(
              `/api/directory?handle=${encodeURIComponent(contact.handle)}`
            )
            recipientTransportKey = entry.public_transport_key
          } catch {
            continue
          }
        }
        try {
          const encryptedBlob = await encryptTransitEnvelope(
            payload,
            recipientTransportKey
          )
          await apiFetch("/messages/send", {
            method: "POST",
            body: {
              recipient_handle: contact.handle,
              encrypted_blob: encryptedBlob,
              message_id: crypto.randomUUID(),
              event_type: "key_rotation",
            },
          })
        } catch {
          // Best-effort key rotation notifications
        }
      }
    },
    [masterKey, identityPrivateKey, publicIdentityKey, user?.handle, user?.id]
  )

  const rotateTransportKey = React.useCallback(async () => {
    if (!masterKey || !identityPrivateKey || !user?.handle) {
      throw new Error("Key material unavailable")
    }
    const rotatedAt = Date.now()
    const transportPair = await generateTransportKeyPair()
    const encryptedTransport = await encryptPrivateKey(
      masterKey,
      transportPair.privateKey
    )

    await apiFetch("/auth/keys/transport", {
      method: "PATCH",
      body: {
        public_transport_key: transportPair.publicKey,
        encrypted_transport_key: encryptedTransport.ciphertext,
        encrypted_transport_iv: encryptedTransport.iv,
        rotated_at: rotatedAt,
      },
    })

    await updateActiveSession({
      transportPrivateKey: encryptedTransport,
      publicTransportKey: transportPair.publicKey,
    })
    setTransportPrivateKey(transportPair.privateKey)
    setPublicTransportKey(transportPair.publicKey)
    await setTransportKeyRotatedAt(rotatedAt)
    try {
      await notifyContactsOfTransportKeyRotation(
        transportPair.publicKey,
        rotatedAt
      )
    } catch {
      // Best-effort notifications
    }
  }, [
    masterKey,
    identityPrivateKey,
    user?.handle,
    notifyContactsOfTransportKeyRotation,
  ])

  const rotationCheckRef = React.useRef(false)

  const checkTransportKeyRotation = React.useCallback(async () => {
    if (rotationCheckRef.current) {
      return
    }
    rotationCheckRef.current = true
    try {
      const lastRotatedAt = await getTransportKeyRotatedAt()
      const now = Date.now()
      if (!lastRotatedAt) {
        await setTransportKeyRotatedAt(now)
        return
      }
      if (now - lastRotatedAt >= TRANSPORT_KEY_ROTATION_MS) {
        // Skip automatic rotation during active calls to avoid signaling issues
        if (isInCall()) {
          console.log("[Auth] Skipping key rotation during active call")
          return
        }
        await rotateTransportKey()
      }
    } finally {
      rotationCheckRef.current = false
    }
  }, [rotateTransportKey])

  React.useEffect(() => {
    if (status !== "authenticated" || !masterKey) {
      return
    }
    let cancelled = false
    const runCheck = async () => {
      if (cancelled) return
      await checkTransportKeyRotation()
    }
    void runCheck()
    const interval = window.setInterval(runCheck, 6 * 60 * 60 * 1000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [status, masterKey, checkTransportKeyRotation])

  const applyTransportKeyRotation = React.useCallback(
    async (payload: TransportKeyRotationPayload) => {
      console.log("[Auth] applyTransportKeyRotation called", { hasMasterKey: !!masterKey })
      if (!masterKey) {
        console.warn("[Auth] Cannot apply transport key rotation - no master key")
        return
      }
      try {
        const encryptedTransport = {
          ciphertext: payload.encrypted_transport_key,
          iv: payload.encrypted_transport_iv,
        }
        const nextTransportKey = await decryptPrivateKey(masterKey, encryptedTransport)
        await updateActiveSession({
          transportPrivateKey: encryptedTransport,
          publicTransportKey: payload.public_transport_key,
        })
        setTransportPrivateKey(nextTransportKey)
        setPublicTransportKey(payload.public_transport_key)

        // Update transport key in IndexedDB for service worker if password is saved
        const session = await loadActiveSession()
        if (session?.savePassword) {
          await storeTransportKeyForSW(nextTransportKey)
          console.log("[Auth] Updated transport key for service worker")
        }

        const rotatedAt = (() => {
          if (typeof payload.rotated_at === "number" && Number.isFinite(payload.rotated_at)) {
            return payload.rotated_at
          }
          if (typeof payload.timestamp === "string") {
            const asNumber = Number(payload.timestamp)
            if (Number.isFinite(asNumber)) {
              return asNumber
            }
            const parsed = Date.parse(payload.timestamp)
            if (!Number.isNaN(parsed)) {
              return parsed
            }
          }
          return Date.now()
        })()
        await setTransportKeyRotatedAt(rotatedAt)
        console.log("[Auth] Transport key rotation applied successfully")
      } catch (error) {
        console.error("[Auth] Failed to apply transport key rotation:", error)
      }
    },
    [masterKey]
  )

  const loadTransportKeyRotatedAt = React.useCallback(async () => {
    return getTransportKeyRotatedAt()
  }, [])

  const fetchSessions = React.useCallback(async (): Promise<SessionInfo[]> => {
    return apiFetch<SessionInfo[]>("/auth/sessions")
  }, [])

  const invalidateSession = React.useCallback(async (sessionId: string): Promise<void> => {
    await apiFetch(`/auth/sessions/${sessionId}`, { method: "DELETE" })
  }, [])

  const invalidateAllOtherSessions = React.useCallback(async (): Promise<number> => {
    const result = await apiFetch<{ count: number }>("/auth/sessions", { method: "DELETE" })
    return result.count
  }, [])

  const fetchPasskeys = React.useCallback(async (): Promise<PasskeyInfo[]> => {
    return apiFetch<PasskeyInfo[]>("/auth/passkeys")
  }, [])

  const addPasskey = React.useCallback(async (name?: string): Promise<PasskeyInfo> => {
    // Get creation options
    const options = await apiFetch<PublicKeyCredentialCreationOptionsJSON>(
      "/auth/passkeys/add/start",
      { method: "POST" }
    )
    // Create passkey
    const response = await startRegistration({ optionsJSON: options })
    // Finish and return new passkey info
    return apiFetch<PasskeyInfo>("/auth/passkeys/add/finish", {
      method: "POST",
      body: { response, name },
    })
  }, [])

  const removePasskey = React.useCallback(async (credentialId: string): Promise<void> => {
    // Get assertion options (excluding target credential)
    const options = await apiFetch<PublicKeyCredentialRequestOptionsJSON>(
      "/auth/passkeys/remove/start",
      {
        method: "POST",
        body: { credential_id: credentialId },
      }
    )
    // Authenticate with different passkey
    const response = await startAuthentication({ optionsJSON: options })
    // Complete removal
    await apiFetch("/auth/passkeys/remove/finish", {
      method: "POST",
      body: { target_credential_id: credentialId, response },
    })
  }, [])

  const registerWithPassword = React.useCallback(
    async (
      usernameInput: string,
      accountPassword: string,
      masterPassword: string,
      _savePassword = false
    ) => {
      console.log("[Auth] registerWithPassword starting for:", usernameInput)
      const { username, handle } = resolveLocalUser(usernameInput)
      console.log("[Auth] Resolved username:", username, "handle:", handle)

      const opaqueStart = await registerStart(accountPassword)
      console.log("[Auth] OPAQUE registerStart completed, request length:", opaqueStart.request.length)

      const startResponse = await apiFetch<{ opaque_response: string }>(
        "/auth/password/register/start",
        {
          method: "POST",
          body: {
            username,
            opaque_request: bytesToBase64(opaqueStart.request),
          },
        }
      )
      console.log("[Auth] Server register/start succeeded, response length:", startResponse.opaque_response.length)

      const totpSecret = generateTotpSecret()
      const totpUri = getTotpUri(totpSecret, handle)

      const onVerify = async (totpCode: string) => {
        console.log("[Auth] onVerify starting, completing registration")
        const opaqueFinish = await registerFinish(
          opaqueStart.state,
          base64ToBytes(startResponse.opaque_response)
        )
        console.log("[Auth] OPAQUE registerFinish completed, finish length:", opaqueFinish.length)

        const kdfSalt = generateSalt()
        const kdfIterations = 310_000
        const masterKey = await deriveMasterKey(
          masterPassword,
          kdfSalt,
          kdfIterations
        )
        const identityPair = await generateIdentityKeyPair()
        const transportPair = await generateTransportKeyPair()
        const encryptedIdentity = await encryptPrivateKey(
          masterKey,
          identityPair.privateKey
        )
        const encryptedTransport = await encryptPrivateKey(
          masterKey,
          transportPair.privateKey
        )
        const encryptedTotp = await encryptTotpSecret(masterKey, totpSecret)

        console.log("[Auth] Keys generated, calling server register/finish")
        const response = await apiFetch<{ recovery_codes: string[] }>(
          "/auth/password/register/finish",
          {
            method: "POST",
            body: {
              username,
              opaque_finish: bytesToBase64(opaqueFinish),
              kdf_salt: bytesToBase64(kdfSalt),
              kdf_iterations: kdfIterations,
              public_identity_key: identityPair.publicKey,
              public_transport_key: transportPair.publicKey,
              encrypted_identity_key: encryptedIdentity.ciphertext,
              encrypted_identity_iv: encryptedIdentity.iv,
              encrypted_transport_key: encryptedTransport.ciphertext,
              encrypted_transport_iv: encryptedTransport.iv,
              totp_secret: totpSecret,
              encrypted_totp_secret: encryptedTotp.ciphertext,
              encrypted_totp_secret_iv: encryptedTotp.iv,
              totp_code: totpCode.trim(),
            },
          }
        )
        console.log("[Auth] Server register/finish succeeded, got", response.recovery_codes.length, "recovery codes")

        return response.recovery_codes
      }

      return { totpSecret, totpUri, onVerify }
    },
    []
  )

  const loginWithPassword = React.useCallback(
    async (usernameInput: string, accountPassword: string) => {
      console.log("[Auth] loginWithPassword starting for:", usernameInput)
      const { username, handle } = resolveLocalUser(usernameInput)
      console.log("[Auth] Resolved username:", username, "handle:", handle)

      const params = await apiFetch<{
        kdf_salt: string
        kdf_iterations: number
      }>(`/auth/params/${encodeURIComponent(username)}`)
      console.log("[Auth] Got params, starting OPAQUE login")

      const loginStartState = await loginStart(accountPassword)
      console.log("[Auth] OPAQUE loginStart completed, request length:", loginStartState.request.length)

      const startResponse = await apiFetch<{ opaque_response: string }>(
        "/auth/password/login/start",
        {
          method: "POST",
          body: {
            username,
            opaque_request: bytesToBase64(loginStartState.request),
          },
        }
      )
      console.log("[Auth] Server login/start succeeded, response length:", startResponse.opaque_response.length)

      const loginFinishState = await loginFinish(
        loginStartState.state,
        base64ToBytes(startResponse.opaque_response)
      )
      console.log("[Auth] OPAQUE loginFinish completed")

      const finishResponse = await apiFetch<{
        requires_2fa: boolean
        session_ticket: string
      }>("/auth/password/login/finish", {
        method: "POST",
        body: {
          username,
          opaque_finish: bytesToBase64(loginFinishState.finishMessage),
        },
      })
      console.log("[Auth] Server login/finish succeeded, requires_2fa:", finishResponse.requires_2fa)

      setPendingPasswordLogin({
        username,
        handle,
        sessionTicket: finishResponse.session_ticket,
        kdfSalt: params.kdf_salt,
        kdfIterations: params.kdf_iterations,
      })
      setPendingKeys(null)
      setStatus("awaiting_2fa")
    },
    []
  )

  const verifyTotp = React.useCallback(
    async (code: string) => {
      if (!pendingPasswordLogin) {
        throw new Error("No pending login session")
      }
      const response = await apiFetch<{
        token: string
        keys: {
          encrypted_identity_key: string
          encrypted_identity_iv: string
          encrypted_transport_key: string
          encrypted_transport_iv: string
          kdf_salt: string
          kdf_iterations: number
          public_identity_key: string
          public_transport_key: string
        }
      }>("/auth/password/login/totp", {
        method: "POST",
        body: {
          session_ticket: pendingPasswordLogin.sessionTicket,
          totp_code: code.trim(),
        },
      })

      setAuthToken(response.token)
      setToken(response.token)
      setUser({
        id: decodeJwtSubject(response.token),
        username: pendingPasswordLogin.username,
        handle: pendingPasswordLogin.handle,
      })
      setPendingPasswordLogin((current) =>
        current
          ? {
            ...current,
            kdfSalt: response.keys.kdf_salt,
            kdfIterations: response.keys.kdf_iterations,
          }
          : current
      )
      setPendingKeys({
        encrypted_identity_key: response.keys.encrypted_identity_key,
        encrypted_identity_iv: response.keys.encrypted_identity_iv,
        encrypted_transport_key: response.keys.encrypted_transport_key,
        encrypted_transport_iv: response.keys.encrypted_transport_iv,
        public_identity_key: response.keys.public_identity_key,
        public_transport_key: response.keys.public_transport_key,
      })
      setPublicIdentityKey(response.keys.public_identity_key)
      setPublicTransportKey(response.keys.public_transport_key)
      setStatus("awaiting_master_password")
    },
    [pendingPasswordLogin]
  )

  const verifyRecoveryCode = React.useCallback(
    async (code: string) => {
      if (!pendingPasswordLogin) {
        throw new Error("No pending login session")
      }
      const response = await apiFetch<{
        token: string
        keys: {
          encrypted_identity_key: string
          encrypted_identity_iv: string
          encrypted_transport_key: string
          encrypted_transport_iv: string
          kdf_salt: string
          kdf_iterations: number
          public_identity_key: string
          public_transport_key: string
        }
        remaining_recovery_codes: number
      }>("/auth/password/login/recovery", {
        method: "POST",
        body: {
          session_ticket: pendingPasswordLogin.sessionTicket,
          recovery_code: normalizeRecoveryCode(code),
        },
      })

      setAuthToken(response.token)
      setToken(response.token)
      setUser({
        id: decodeJwtSubject(response.token),
        username: pendingPasswordLogin.username,
        handle: pendingPasswordLogin.handle,
      })
      setPendingPasswordLogin((current) =>
        current
          ? {
            ...current,
            kdfSalt: response.keys.kdf_salt,
            kdfIterations: response.keys.kdf_iterations,
          }
          : current
      )
      setPendingKeys({
        encrypted_identity_key: response.keys.encrypted_identity_key,
        encrypted_identity_iv: response.keys.encrypted_identity_iv,
        encrypted_transport_key: response.keys.encrypted_transport_key,
        encrypted_transport_iv: response.keys.encrypted_transport_iv,
        public_identity_key: response.keys.public_identity_key,
        public_transport_key: response.keys.public_transport_key,
      })
      setPublicIdentityKey(response.keys.public_identity_key)
      setPublicTransportKey(response.keys.public_transport_key)
      setStatus("awaiting_master_password")

      return { remainingCodes: response.remaining_recovery_codes }
    },
    [pendingPasswordLogin]
  )

  const unlockAfter2FA = React.useCallback(
    async (masterPassword: string, savePassword = false) => {
      if (!pendingPasswordLogin || !pendingKeys || !token) {
        throw new Error("No pending login to unlock")
      }
      const masterKey = await deriveMasterKey(
        masterPassword,
        base64ToBytes(pendingPasswordLogin.kdfSalt),
        pendingPasswordLogin.kdfIterations
      )

      const identityPrivateKey = await decryptPrivateKey(masterKey, {
        ciphertext: pendingKeys.encrypted_identity_key,
        iv: pendingKeys.encrypted_identity_iv,
      })
      const transportPrivateKey = await decryptPrivateKey(masterKey, {
        ciphertext: pendingKeys.encrypted_transport_key,
        iv: pendingKeys.encrypted_transport_iv,
      })

      if (
        identityPrivateKey.length !== identitySecretKeyLength ||
        transportPrivateKey.length !== transportSecretKeyLength
      ) {
        throw new Error("Invalid key material")
      }

      await persistActiveSession({
        username: pendingPasswordLogin.username,
        handle: pendingPasswordLogin.handle,
        kdfSalt: pendingPasswordLogin.kdfSalt,
        kdfIterations: pendingPasswordLogin.kdfIterations,
        identityPrivateKey: {
          ciphertext: pendingKeys.encrypted_identity_key,
          iv: pendingKeys.encrypted_identity_iv,
        },
        transportPrivateKey: {
          ciphertext: pendingKeys.encrypted_transport_key,
          iv: pendingKeys.encrypted_transport_iv,
        },
        publicIdentityKey: pendingKeys.public_identity_key,
        publicTransportKey: pendingKeys.public_transport_key,
        token,
        savePassword,
      })

      if (savePassword) {
        await db.syncState.put({
          key: "masterKey",
          value: await exportMasterKey(masterKey),
        })
        await storeTransportKeyForSW(transportPrivateKey)
      } else {
        await clearTransportKeyForSW()
      }

      setMasterKey(masterKey)
      setIdentityPrivateKey(identityPrivateKey)
      setTransportPrivateKey(transportPrivateKey)
      setPublicIdentityKey(pendingKeys.public_identity_key)
      setPublicTransportKey(pendingKeys.public_transport_key)
      setStatus("authenticated")
      setPendingPasswordLogin(null)
      setPendingKeys(null)
    },
    [pendingPasswordLogin, pendingKeys, token]
  )

  const cancelPasswordLogin = React.useCallback(() => {
    setPendingPasswordLogin(null)
    setPendingKeys(null)
    setToken(null)
    setAuthToken(null)
    setUser(null)
    setMasterKey(null)
    setIdentityPrivateKey(null)
    setPublicIdentityKey(null)
    setTransportPrivateKey(null)
    setPublicTransportKey(null)
    setStatus("guest")
  }, [])

  const fetchAuthMethods = React.useCallback(async () => {
    return apiFetch<AuthMethods>("/auth/methods")
  }, [])

  const addPasswordAuth = React.useCallback(
    async (accountPassword: string, masterPassword: string) => {
      if (!user?.username || !user.handle) {
        throw new Error("User not available")
      }
      const session = await loadActiveSession()
      if (!session) {
        throw new Error("No active session")
      }
      const derivedMasterKey = await deriveMasterKey(
        masterPassword,
        base64ToBytes(session.kdfSalt),
        session.kdfIterations
      )
      const identityPrivateKey = await decryptPrivateKey(
        derivedMasterKey,
        session.identityPrivateKey
      )
      const transportPrivateKey = await decryptPrivateKey(
        derivedMasterKey,
        session.transportPrivateKey
      )
      if (
        identityPrivateKey.length !== identitySecretKeyLength ||
        transportPrivateKey.length !== transportSecretKeyLength
      ) {
        throw new Error("Invalid master password")
      }

      const opaqueStart = await registerStart(accountPassword)
      const startResponse = await apiFetch<{ opaque_response: string }>(
        "/auth/password/register/start",
        {
          method: "POST",
          body: {
            username: user.username,
            opaque_request: bytesToBase64(opaqueStart.request),
          },
        }
      )
      const opaqueFinish = await registerFinish(
        opaqueStart.state,
        base64ToBytes(startResponse.opaque_response)
      )

      const totpSecret = generateTotpSecret()
      const totpUri = getTotpUri(totpSecret, user.handle)
      const encryptedTotp = await encryptTotpSecret(
        derivedMasterKey,
        totpSecret
      )

      const onVerify = async (totpCode: string) => {
        const response = await apiFetch<{ recovery_codes: string[] }>(
          "/auth/password-2fa/add",
          {
            method: "POST",
            body: {
              opaque_request: bytesToBase64(opaqueStart.request),
              opaque_finish: bytesToBase64(opaqueFinish),
              totp_secret: totpSecret,
              encrypted_totp_secret: encryptedTotp.ciphertext,
              encrypted_totp_secret_iv: encryptedTotp.iv,
              totp_code: totpCode.trim(),
            },
          }
        )

        return response.recovery_codes
      }

      return { totpSecret, totpUri, onVerify }
    },
    [user]
  )

  const removePasswordAuth = React.useCallback(async () => {
    await apiFetch("/auth/password-2fa", { method: "DELETE" })
  }, [])

  const regenerateTotp = React.useCallback(async () => {
    if (!masterKey) {
      throw new Error("Master key unavailable")
    }
    if (!user?.handle) {
      throw new Error("User not available")
    }

    const totpSecret = generateTotpSecret()
    const totpUri = getTotpUri(totpSecret, user.handle)
    const encryptedTotp = await encryptTotpSecret(masterKey, totpSecret)

    const onVerify = async (totpCode: string) => {
      const response = await apiFetch<{ recovery_codes: string[] }>(
        "/auth/totp/regenerate",
        {
          method: "POST",
          body: {
            totp_secret: totpSecret,
            encrypted_totp_secret: encryptedTotp.ciphertext,
            encrypted_totp_secret_iv: encryptedTotp.iv,
            totp_code: totpCode.trim(),
          },
        }
      )
      return response.recovery_codes
    }

    return { totpSecret, totpUri, onVerify }
  }, [masterKey, user?.handle])

  const regenerateRecoveryCodes = React.useCallback(async () => {
    const response = await apiFetch<{ recovery_codes: string[] }>(
      "/auth/totp/recovery-codes/regenerate",
      { method: "POST" }
    )
    return response.recovery_codes
  }, [])

  const changeAccountPassword = React.useCallback(
    async (currentPassword: string, newPassword: string) => {
      // Step 1: Start password change - verify current password
      const currentLoginState = await loginStart(currentPassword)
      const startResponse = await apiFetch<{
        opaque_response: string
        change_ticket: string
      }>("/auth/password/change/start", {
        method: "POST",
        body: {
          opaque_request: bytesToBase64(currentLoginState.request),
        },
      })

      // Step 2: Complete current password verification
      const currentLoginFinish = await loginFinish(
        currentLoginState.state,
        base64ToBytes(startResponse.opaque_response)
      )
      await apiFetch("/auth/password/change/verify", {
        method: "POST",
        headers: {
          "X-Change-Ticket": startResponse.change_ticket,
        },
        body: {
          opaque_finish: bytesToBase64(currentLoginFinish.finishMessage),
        },
      })

      // Step 3: Start new password registration
      const newRegisterState = await registerStart(newPassword)
      const newStartResponse = await apiFetch<{ opaque_response: string }>(
        "/auth/password/change/new/start",
        {
          method: "POST",
          body: {
            change_ticket: startResponse.change_ticket,
            opaque_request: bytesToBase64(newRegisterState.request),
          },
        }
      )

      // Step 4: Complete new password registration
      const newRegisterFinish = await registerFinish(
        newRegisterState.state,
        base64ToBytes(newStartResponse.opaque_response)
      )
      await apiFetch("/auth/password/change/complete", {
        method: "POST",
        body: {
          change_ticket: startResponse.change_ticket,
          opaque_finish: bytesToBase64(newRegisterFinish),
        },
      })
    },
    []
  )

  const logout = React.useCallback(() => {
    void clearSession(true)
  }, [clearSession])

  // Initialize push notifications when authenticated
  React.useEffect(() => {
    if (status !== "authenticated" || !transportPrivateKey) {
      // Clear transport key when entering locked state
      if (status === "locked") {
        void clearTransportKeyForSW()
      }
      return
    }

    let cancelled = false

    // Register service worker and subscribe to push
    void (async () => {
      try {
        await registerServiceWorker()
        if (cancelled) return

        // Auto-subscribe to push if not already subscribed
        // User can disable in settings later
        await subscribeToPush()
        if (cancelled) return

        // Store transport key for SW while authenticated
        // This allows SW to decrypt notifications while app is open
        // Key is cleared on logout/lock via clearTransportKeyForSW
        await storeTransportKeyForSW(transportPrivateKey)
      } catch (error) {
        console.error("[Auth] Push notification setup failed:", error)
      }
    })()

    // Set up push decryption handler for when SW forwards encrypted notifications
    const cleanupDecryption = setupPushDecryptionHandler(transportPrivateKey)

    // Set up notification click handler for navigation
    const cleanupClick = setupNotificationClickHandler((path) => {
      // Navigate to the path when notification is clicked
      if (typeof window !== "undefined") {
        window.location.href = path
      }
    })

    return () => {
      cancelled = true
      cleanupDecryption()
      cleanupClick()
      // Note: Don't unregister SW or clear transport key here
      // Only do that on full logout via clearSession()
    }
  }, [status, transportPrivateKey])

  const value = React.useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      token,
      masterKey,
      identityPrivateKey,
      publicIdentityKey,
      transportPrivateKey,
      publicTransportKey,
      capabilities,
      register,
      loginWithPasskey,
      unlock,
      deleteAccount,
      logout,
      fetchSessions,
      invalidateSession,
      invalidateAllOtherSessions,
      rotateTransportKey,
      applyTransportKeyRotation,
      getTransportKeyRotatedAt: loadTransportKeyRotatedAt,
      fetchPasskeys,
      addPasskey,
      removePasskey,
      registerWithPassword,
      loginWithPassword,
      verifyTotp,
      verifyRecoveryCode,
      unlockAfter2FA,
      cancelPasswordLogin,
      fetchAuthMethods,
      addPasswordAuth,
      removePasswordAuth,
      regenerateTotp,
      regenerateRecoveryCodes,
      changeAccountPassword,
    }),
    [
      status,
      user,
      token,
      masterKey,
      identityPrivateKey,
      publicIdentityKey,
      transportPrivateKey,
      publicTransportKey,
      capabilities,
      register,
      loginWithPasskey,
      unlock,
      deleteAccount,
      logout,
      fetchSessions,
      invalidateSession,
      invalidateAllOtherSessions,
      rotateTransportKey,
      applyTransportKeyRotation,
      loadTransportKeyRotatedAt,
      fetchPasskeys,
      addPasskey,
      removePasskey,
      registerWithPassword,
      loginWithPassword,
      verifyTotp,
      verifyRecoveryCode,
      unlockAfter2FA,
      cancelPasswordLogin,
      fetchAuthMethods,
      addPasswordAuth,
      removePasswordAuth,
      regenerateTotp,
      regenerateRecoveryCodes,
      changeAccountPassword,
    ]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = React.useContext(AuthContext)
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider")
  }
  return context
}
