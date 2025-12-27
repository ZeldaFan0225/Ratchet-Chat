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
  exportTransportPrivateKey,
  getIdentityPublicKey,
  getSubtleCrypto,
  generateIdentityKeyPair,
  generateSalt,
  generateTransportKeyPair,
  importTransportPrivateKey,
  signMessage,
  type EncryptedPayload,
} from "@/lib/crypto"
import { getInstanceHost, normalizeHandle, splitHandle } from "@/lib/handles"
import { decodeContactRecord } from "@/lib/messageUtils"
import {
  computeClientProof,
  computeVerifier,
  generateClientEphemeral,
  generateSrpSalt,
  verifyServerProof,
} from "@/lib/srp"
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
}

type PreviousTransportKeyRecord = {
  encrypted: EncryptedPayload
  expiresAt: number
}

export type TransportKeyRotationPayload = {
  public_transport_key: string
  encrypted_transport_key: string
  encrypted_transport_iv: string
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

type AuthContextValue = {
  status: "loading" | "guest" | "authenticated"
  user: { id: string | null; username: string; handle: string } | null
  token: string | null
  masterKey: CryptoKey | null
  identityPrivateKey: Uint8Array | null
  transportPrivateKey: CryptoKey | null
  previousTransportPrivateKey: CryptoKey | null
  publicTransportKey: string | null
  register: (username: string, password: string) => Promise<void>
  login: (username: string, password: string) => Promise<void>
  deleteAccount: () => Promise<void>
  logout: () => void
  fetchSessions: () => Promise<SessionInfo[]>
  invalidateSession: (sessionId: string) => Promise<void>
  invalidateAllOtherSessions: () => Promise<number>
  rotateTransportKey: () => Promise<void>
  applyTransportKeyRotation: (payload: TransportKeyRotationPayload) => Promise<void>
  getTransportKeyRotatedAt: () => Promise<number | null>
}

const ACTIVE_SESSION_KEY = "active_session"
const TRANSPORT_KEY_ROTATED_AT_KEY = "transportKeyRotatedAt"
const TRANSPORT_KEY_ROTATION_MS = 30 * 24 * 60 * 60 * 1000
const PREVIOUS_TRANSPORT_KEY_KEY = "previousTransportKey"
const TRANSPORT_KEY_GRACE_MS = 72 * 60 * 60 * 1000
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

async function getPreviousTransportKeyRecord(): Promise<PreviousTransportKeyRecord | null> {
  const record = await db.syncState.get(PREVIOUS_TRANSPORT_KEY_KEY)
  const value = record?.value
  if (!value || typeof value !== "object") {
    return null
  }
  const parsed = value as PreviousTransportKeyRecord
  if (
    !parsed.encrypted ||
    typeof parsed.encrypted.ciphertext !== "string" ||
    typeof parsed.encrypted.iv !== "string" ||
    typeof parsed.expiresAt !== "number"
  ) {
    return null
  }
  return parsed
}

async function setPreviousTransportKeyRecord(record: PreviousTransportKeyRecord | null) {
  if (!record) {
    await db.syncState.delete(PREVIOUS_TRANSPORT_KEY_KEY)
    return
  }
  await db.syncState.put({ key: PREVIOUS_TRANSPORT_KEY_KEY, value: record })
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
  const [status, setStatus] = React.useState<"loading" | "guest" | "authenticated">("loading")
  const [token, setToken] = React.useState<string | null>(null)
  const [user, setUser] = React.useState<{
    id: string | null
    username: string
    handle: string
  } | null>(null)
  const [masterKey, setMasterKey] = React.useState<CryptoKey | null>(null)
  const [identityPrivateKey, setIdentityPrivateKey] =
    React.useState<Uint8Array | null>(null)
  const [transportPrivateKey, setTransportPrivateKey] =
    React.useState<CryptoKey | null>(null)
  const [previousTransportPrivateKey, setPreviousTransportPrivateKey] =
    React.useState<CryptoKey | null>(null)
  const [publicTransportKey, setPublicTransportKey] =
    React.useState<string | null>(null)

  const clearSession = React.useCallback(async (callLogoutApi = true) => {
    if (callLogoutApi && token) {
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

    setStatus("guest")
    setUser(null)
    setToken(null)
    setMasterKey(null)
    setIdentityPrivateKey(null)
    setTransportPrivateKey(null)
    setPreviousTransportPrivateKey(null)
    setPublicTransportKey(null)
    setAuthToken(null)

    if (typeof window !== "undefined") {
      window.localStorage.clear()
      window.sessionStorage.clear()
    }

    // Clear master key from IndexedDB before full delete
    try {
      await db.syncState.delete("masterKey")
      await db.syncState.delete(LAST_SELECTED_CHAT_KEY)
    } catch {
      // Best-effort
    }

    void db.delete().then(() => db.open()).catch(() => {})
  }, [token])

  React.useEffect(() => {
    setUnauthorizedHandler(() => clearSession())
    return () => setUnauthorizedHandler(null)
  }, [clearSession])

  const refreshPreviousTransportKey = React.useCallback(async (key?: CryptoKey | null) => {
    const activeKey = key ?? masterKey
    if (!activeKey) {
      setPreviousTransportPrivateKey(null)
      return
    }
    const record = await getPreviousTransportKeyRecord()
    if (!record) {
      setPreviousTransportPrivateKey(null)
      return
    }
    if (record.expiresAt <= Date.now()) {
      await setPreviousTransportKeyRecord(null)
      setPreviousTransportPrivateKey(null)
      return
    }
    try {
      const previousBytes = await decryptPrivateKey(activeKey, record.encrypted)
      const previousKey = await importTransportPrivateKey(previousBytes)
      setPreviousTransportPrivateKey(previousKey)
    } catch {
      setPreviousTransportPrivateKey(null)
    }
  }, [masterKey])

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

        // Load master key from IndexedDB (persistent sessions)
        const masterKeyRecord = await db.syncState.get("masterKey")
        const masterKeyJson = masterKeyRecord?.value as string | undefined
        if (!masterKeyJson) {
          // Session exists but master key is missing - clear and go to guest
          await clearStaleData()
          setStatus("guest")
          return
        }
        const masterKey = await importMasterKey(masterKeyJson)

        const identityPrivateKey = await decryptPrivateKey(masterKey, session.identityPrivateKey)
        const transportPrivateBytes = await decryptPrivateKey(masterKey, session.transportPrivateKey)
        const transportPrivateKey = await importTransportPrivateKey(transportPrivateBytes)

        const userId = decodeJwtSubject(session.token)

        setAuthToken(session.token)
        setStatus("authenticated")
        setToken(session.token)
        setUser({
          id: userId,
          username: session.username,
          handle: session.handle,
        })
        setMasterKey(masterKey)
        setIdentityPrivateKey(identityPrivateKey)
        setTransportPrivateKey(transportPrivateKey)
        setPublicTransportKey(session.publicTransportKey)
        await refreshPreviousTransportKey(masterKey)
      } catch {
        // Restoration failed - clear data and go to guest
        await clearStaleData()
        setStatus("guest")
      }
    }
    void restore()
  }, [])

  React.useEffect(() => {
    if (status !== "authenticated" || !masterKey) {
      setPreviousTransportPrivateKey(null)
      return
    }
    void refreshPreviousTransportKey()
  }, [status, masterKey, refreshPreviousTransportKey])

  const register = React.useCallback(async (usernameInput: string, password: string) => {
    const { username, handle } = resolveLocalUser(usernameInput)
    const kdfSalt = generateSalt()
    const kdfIterations = 310_000
    const masterKey = await deriveMasterKey(password, kdfSalt, kdfIterations)
    const srpSaltBytes = generateSrpSalt()
    const srpSalt = bytesToBase64(srpSaltBytes)
    const srpVerifier = await computeVerifier(username, password, srpSalt)

    const identityPair = await generateIdentityKeyPair()
    const transportPair = await generateTransportKeyPair()

    const encryptedIdentity = await encryptPrivateKey(
      masterKey,
      identityPair.privateKey
    )
    const transportPrivateBytes = await exportTransportPrivateKey(
      transportPair.privateKey
    )
    const encryptedTransport = await encryptPrivateKey(
      masterKey,
      transportPrivateBytes
    )

    await apiFetch("/auth/register", {
      method: "POST",
      body: {
        username,
        kdf_salt: bytesToBase64(kdfSalt),
        kdf_iterations: kdfIterations,
        public_identity_key: identityPair.publicKey,
        public_transport_key: transportPair.publicKey,
        encrypted_identity_key: encryptedIdentity.ciphertext,
        encrypted_identity_iv: encryptedIdentity.iv,
        encrypted_transport_key: encryptedTransport.ciphertext,
        encrypted_transport_iv: encryptedTransport.iv,
        srp_salt: srpSalt,
        srp_verifier: srpVerifier,
      },
    })

    const { A, a } = generateClientEphemeral()
    const startResponse = await apiFetch<{ salt: string; B: string }>(
      "/auth/srp/start",
      {
        method: "POST",
        body: { username, A },
      }
    )
    const proof = await computeClientProof({
      username,
      password,
      saltBase64: startResponse.salt,
      ABase64: A,
      BBase64: startResponse.B,
      a,
    })
    const loginResponse = await apiFetch<{
      token: string
      M2: string
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
    }>("/auth/srp/verify", {
      method: "POST",
      body: {
        username,
        A,
        M1: proof.M1,
      },
    })
    const ok = await verifyServerProof({
      ABase64: A,
      M1Base64: proof.M1,
      key: proof.key,
      M2Base64: loginResponse.M2,
    })
    if (!ok) {
      throw new Error("Unable to verify server proof")
    }
    
    setAuthToken(loginResponse.token)

    const userId = decodeJwtSubject(loginResponse.token)
    await persistActiveSession({
      username,
      handle,
      kdfSalt: bytesToBase64(kdfSalt),
      kdfIterations,
      identityPrivateKey: encryptedIdentity,
      transportPrivateKey: encryptedTransport,
      publicIdentityKey: identityPair.publicKey,
      publicTransportKey: transportPair.publicKey,
      token: loginResponse.token
    })
    
    // Store master key in IndexedDB for persistent sessions
    await db.syncState.put({ key: "masterKey", value: await exportMasterKey(masterKey) })

    setStatus("authenticated")
    setToken(loginResponse.token)
    setUser({ id: userId, username, handle })
    setMasterKey(masterKey)
    setIdentityPrivateKey(identityPair.privateKey)
    setTransportPrivateKey(transportPair.privateKey)
    setPublicTransportKey(transportPair.publicKey)
  }, [])

  const login = React.useCallback(async (usernameInput: string, password: string) => {
    const { username, handle } = resolveLocalUser(usernameInput)
    const params = await apiFetch<{
      kdf_salt: string
      kdf_iterations: number
    }>(`/auth/params/${encodeURIComponent(username)}`)
    const masterKey = await deriveMasterKey(
      password,
      base64ToBytes(params.kdf_salt),
      params.kdf_iterations
    )
    const { A, a } = generateClientEphemeral()
    const startResponse = await apiFetch<{ salt: string; B: string }>(
      "/auth/srp/start",
      {
        method: "POST",
        body: { username, A },
      }
    )
    const proof = await computeClientProof({
      username,
      password,
      saltBase64: startResponse.salt,
      ABase64: A,
      BBase64: startResponse.B,
      a,
    })
    const loginResponse = await apiFetch<{
      token: string
      M2: string
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
    }>("/auth/srp/verify", {
      method: "POST",
      body: {
        username,
        A,
        M1: proof.M1,
      },
    })
    const verified = await verifyServerProof({
      ABase64: A,
      M1Base64: proof.M1,
      key: proof.key,
      M2Base64: loginResponse.M2,
    })
    if (!verified) {
      throw new Error("Unable to verify server proof")
    }
    
    const identityPrivateKey = await decryptPrivateKey(
      masterKey,
      {
        ciphertext: loginResponse.keys.encrypted_identity_key,
        iv: loginResponse.keys.encrypted_identity_iv,
      }
    )
    const transportPrivateBytes = await decryptPrivateKey(
      masterKey,
      {
        ciphertext: loginResponse.keys.encrypted_transport_key,
        iv: loginResponse.keys.encrypted_transport_iv,
      }
    )
    const transportPrivateKey = await importTransportPrivateKey(
      transportPrivateBytes
    )
    
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
      token: loginResponse.token
    })
    
    // Store master key in IndexedDB for persistent sessions
    await db.syncState.put({ key: "masterKey", value: await exportMasterKey(masterKey) })

    setStatus("authenticated")
    setToken(loginResponse.token)
    setUser({ id: userId, username, handle })
    setMasterKey(masterKey)
    setIdentityPrivateKey(identityPrivateKey)
    setTransportPrivateKey(transportPrivateKey)
    setPublicTransportKey(loginResponse.keys.public_transport_key)
  }, [])

  const deleteAccount = React.useCallback(async () => {
    await apiFetch("/auth/account", { method: "DELETE" })
    await clearSession(false) // Don't call logout API, account is already deleted
  }, [clearSession])

  const stashPreviousTransportKey = React.useCallback(async () => {
    const session = await loadActiveSession()
    if (!session?.transportPrivateKey) {
      return
    }
    await setPreviousTransportKeyRecord({
      encrypted: session.transportPrivateKey,
      expiresAt: Date.now() + TRANSPORT_KEY_GRACE_MS,
    })
    if (transportPrivateKey) {
      setPreviousTransportPrivateKey(transportPrivateKey)
    }
  }, [transportPrivateKey])

  const notifyContactsOfTransportKeyRotation = React.useCallback(
    async (publicTransportKey: string, rotatedAt: number) => {
      if (!masterKey || !identityPrivateKey || !user?.handle) {
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
        sender_identity_key: getIdentityPublicKey(identityPrivateKey),
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
    [masterKey, identityPrivateKey, user?.handle, user?.id]
  )

  const rotateTransportKey = React.useCallback(async () => {
    if (!masterKey || !identityPrivateKey || !user?.handle) {
      throw new Error("Key material unavailable")
    }
    const rotatedAt = Date.now()
    await stashPreviousTransportKey()
    const transportPair = await generateTransportKeyPair()
    const transportPrivateBytes = await exportTransportPrivateKey(
      transportPair.privateKey
    )
    const encryptedTransport = await encryptPrivateKey(
      masterKey,
      transportPrivateBytes
    )

    await apiFetch("/auth/keys/transport", {
      method: "PATCH",
      body: {
        public_transport_key: transportPair.publicKey,
        encrypted_transport_key: encryptedTransport.ciphertext,
        encrypted_transport_iv: encryptedTransport.iv,
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
    stashPreviousTransportKey,
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
        await rotateTransportKey()
      }
      await refreshPreviousTransportKey()
    } finally {
      rotationCheckRef.current = false
    }
  }, [rotateTransportKey, refreshPreviousTransportKey])

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
      if (!masterKey) {
        return
      }
      try {
        await stashPreviousTransportKey()
        const encryptedTransport = {
          ciphertext: payload.encrypted_transport_key,
          iv: payload.encrypted_transport_iv,
        }
        const transportPrivateBytes = await decryptPrivateKey(
          masterKey,
          encryptedTransport
        )
        const nextTransportKey = await importTransportPrivateKey(
          transportPrivateBytes
        )
        await updateActiveSession({
          transportPrivateKey: encryptedTransport,
          publicTransportKey: payload.public_transport_key,
        })
        setTransportPrivateKey(nextTransportKey)
        await setTransportKeyRotatedAt(Date.now())
      } catch {
        // Best-effort rotation apply
      }
    },
    [masterKey, stashPreviousTransportKey]
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

  const logout = React.useCallback(() => {
    void clearSession(true)
  }, [clearSession])

  const value = React.useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      token,
      masterKey,
      identityPrivateKey,
      transportPrivateKey,
      previousTransportPrivateKey,
      publicTransportKey,
      register,
      login,
      deleteAccount,
      logout,
      fetchSessions,
      invalidateSession,
      invalidateAllOtherSessions,
      rotateTransportKey,
      applyTransportKeyRotation,
      getTransportKeyRotatedAt: loadTransportKeyRotatedAt,
    }),
    [
      status,
      user,
      token,
      masterKey,
      identityPrivateKey,
      transportPrivateKey,
      previousTransportPrivateKey,
      register,
      login,
      deleteAccount,
      logout,
      fetchSessions,
      invalidateSession,
      invalidateAllOtherSessions,
      rotateTransportKey,
      applyTransportKeyRotation,
      loadTransportKeyRotatedAt,
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
