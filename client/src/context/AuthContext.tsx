"use client"

import * as React from "react"

import { apiFetch, setAuthToken } from "@/lib/api"
import { db } from "@/lib/db"
import {
  base64ToArrayBuffer,
  base64ToBytes,
  bytesToBase64,
  decryptPrivateKey,
  deriveMasterKey,
  encryptPrivateKey,
  exportTransportPrivateKey,
  getSubtleCrypto,
  generateIdentityKeyPair,
  generateSalt,
  generateTransportKeyPair,
  importTransportPrivateKey,
  type EncryptedPayload,
} from "@/lib/crypto"
import { getInstanceHost, normalizeHandle, splitHandle } from "@/lib/handles"
import {
  computeClientProof,
  computeVerifier,
  generateClientEphemeral,
  generateSrpSalt,
  verifyServerProof,
} from "@/lib/srp"

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

type AuthContextValue = {
  status: "guest" | "authenticated"
  user: { id: string | null; username: string; handle: string } | null
  token: string | null
  masterKey: CryptoKey | null
  identityPrivateKey: Uint8Array | null
  transportPrivateKey: CryptoKey | null
  register: (username: string, password: string) => Promise<void>
  login: (username: string, password: string) => Promise<void>
  logout: () => void
}

const ACTIVE_SESSION_KEY = "active_session"

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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<"guest" | "authenticated">("guest")
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

  const clearSession = React.useCallback(() => {
    setStatus("guest")
    setUser(null)
    setToken(null)
    setMasterKey(null)
    setIdentityPrivateKey(null)
    setTransportPrivateKey(null)
    setAuthToken(null)
    
    if (typeof window !== "undefined") {
      window.localStorage.clear()
      window.sessionStorage.clear()
    }
    
    void db.delete().then(() => db.open()).catch(() => {})
  }, [])

  React.useEffect(() => {
    const restore = async () => {
      try {
        const session = await loadActiveSession()
        if (!session) {
          return
        }
        
        const masterKeyJson = window.sessionStorage.getItem("ratchet-chat:master-key")
        if (!masterKeyJson) {
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
      } catch {
        clearSession()
      }
    }
    void restore()
  }, [clearSession])

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
    
    window.sessionStorage.setItem("ratchet-chat:master-key", await exportMasterKey(masterKey))

    setStatus("authenticated")
    setToken(loginResponse.token)
    setUser({ id: userId, username, handle })
    setMasterKey(masterKey)
    setIdentityPrivateKey(identityPair.privateKey)
    setTransportPrivateKey(transportPair.privateKey)
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
    
    window.sessionStorage.setItem("ratchet-chat:master-key", await exportMasterKey(masterKey))

    setStatus("authenticated")
    setToken(loginResponse.token)
    setUser({ id: userId, username, handle })
    setMasterKey(masterKey)
    setIdentityPrivateKey(identityPrivateKey)
    setTransportPrivateKey(transportPrivateKey)
  }, [])


  const value = React.useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      token,
      masterKey,
      identityPrivateKey,
      transportPrivateKey,
      register,
      login,
      logout: clearSession,
    }),
    [
      status,
      user,
      token,
      masterKey,
      identityPrivateKey,
      transportPrivateKey,
      register,
      login,
      clearSession,
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