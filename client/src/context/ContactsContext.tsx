"use client"

import * as React from "react"
import { apiFetch } from "@/lib/api"
import { db } from "@/lib/db"
import { decryptString, encryptString, type EncryptedPayload } from "@/lib/crypto"
import { normalizeHandle, splitHandle } from "@/lib/handles"
import { getContactDisplayName, normalizeNickname } from "@/lib/contacts"
import { decodeContactRecord, saveContactRecord } from "@/lib/messageUtils"
import type { Contact } from "@/types/dashboard"
import { useAuth } from "./AuthContext"

type ContactsPayload = {
  contacts: Contact[]
}

type ContactsContextValue = {
  contacts: Contact[]
  isLoading: boolean
  addContact: (contact: Contact, options?: { syncServer?: boolean }) => Promise<void>
  addContactByHandle: (handleInput: string) => Promise<Contact>
  removeContact: (handle: string) => Promise<void>
  refreshContacts: () => Promise<void>
  applyEncryptedContacts: (encrypted: EncryptedPayload | null) => Promise<void>
}

const CONTACTS_KEY = "encryptedContacts"

const ContactsContext = React.createContext<ContactsContextValue | undefined>(
  undefined
)

function normalizeContact(contact: Contact): Contact {
  const handle = normalizeHandle(contact.handle)
  const parts = splitHandle(handle)
  const normalizedNickname = normalizeNickname(contact.nickname)
  return {
    handle: parts?.handle ?? handle,
    username: contact.username || parts?.username || handle,
    nickname: normalizedNickname,
    host: contact.host || parts?.host || "",
    publicIdentityKey: contact.publicIdentityKey ?? "",
    publicTransportKey: contact.publicTransportKey ?? "",
    avatar_filename: contact.avatar_filename,
    createdAt: contact.createdAt,
  }
}

function mergeContact(existing: Contact, incoming: Contact): Contact {
  const existingCreated = existing.createdAt
  const incomingCreated = incoming.createdAt
  const createdAt =
    existingCreated && incomingCreated
      ? new Date(existingCreated) <= new Date(incomingCreated)
        ? existingCreated
        : incomingCreated
      : existingCreated ?? incomingCreated
  return {
    handle: incoming.handle || existing.handle,
    username: incoming.username || existing.username,
    nickname:
      incoming.nickname !== undefined ? incoming.nickname : existing.nickname,
    host: incoming.host || existing.host,
    publicIdentityKey: incoming.publicIdentityKey || existing.publicIdentityKey,
    publicTransportKey:
      incoming.publicTransportKey || existing.publicTransportKey,
    avatar_filename:
      incoming.avatar_filename !== undefined
        ? incoming.avatar_filename
        : existing.avatar_filename,
    createdAt,
  }
}

function mergeContacts(base: Contact[], incoming: Contact[]): Contact[] {
  const map = new Map<string, Contact>()
  for (const contact of base) {
    const normalized = normalizeContact(contact)
    map.set(normalized.handle.toLowerCase(), normalized)
  }
  for (const contact of incoming) {
    const normalized = normalizeContact(contact)
    const key = normalized.handle.toLowerCase()
    const existing = map.get(key)
    map.set(key, existing ? mergeContact(existing, normalized) : normalized)
  }
  return Array.from(map.values()).sort((a, b) =>
    getContactDisplayName(a).localeCompare(getContactDisplayName(b))
  )
}

function contactsEqual(a: Contact[], b: Contact[]): boolean {
  if (a.length !== b.length) return false
  const normalizeForCompare = (contact: Contact) => ({
    handle: contact.handle,
    username: contact.username ?? "",
    nickname: normalizeNickname(contact.nickname) ?? "",
    host: contact.host ?? "",
    publicIdentityKey: contact.publicIdentityKey ?? "",
    publicTransportKey: contact.publicTransportKey ?? "",
    avatar_filename: contact.avatar_filename ?? "",
  })
  const sorted = (contacts: Contact[]) =>
    [...contacts]
      .map(normalizeContact)
      .map(normalizeForCompare)
      .sort((left, right) => left.handle.localeCompare(right.handle))
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
}

async function deleteMissingContacts(
  ownerId: string,
  keepHandles: Set<string>
) {
  const existing = await db.contacts.where("ownerId").equals(ownerId).toArray()
  const toDelete = existing
    .filter((record) => !keepHandles.has(record.id.toLowerCase()))
    .map((record) => record.id)
  if (toDelete.length > 0) {
    await db.contacts.bulkDelete(toDelete)
  }
}

export function ContactsProvider({ children }: { children: React.ReactNode }) {
  const { status, masterKey, user } = useAuth()
  const [contacts, setContacts] = React.useState<Contact[]>([])
  const [isLoading, setIsLoading] = React.useState(true)

  const persistContacts = React.useCallback(
    async (nextContacts: Contact[], syncServer = true) => {
      if (!masterKey) return
      const payload: ContactsPayload = { contacts: nextContacts }
      const encrypted = await encryptString(
        masterKey,
        JSON.stringify(payload)
      )
      await db.syncState.put({
        key: CONTACTS_KEY,
        value: encrypted,
      })
      if (syncServer) {
        apiFetch("/auth/contacts", { method: "PUT", body: encrypted }).catch(
          (error) => {
            console.error("Failed to sync contacts to server:", error)
          }
        )
      }
    },
    [masterKey]
  )

  const saveContactsToDb = React.useCallback(
    async (nextContacts: Contact[]) => {
      if (!masterKey || !user?.handle) return
      const ownerId = user.id ?? user.handle
      await Promise.all(
        nextContacts.map((contact) =>
          saveContactRecord(masterKey, ownerId, contact)
        )
      )
    },
    [masterKey, user?.handle, user?.id]
  )

  const addContact = React.useCallback(
    async (contact: Contact, options?: { syncServer?: boolean }) => {
      const normalized = normalizeContact(contact)
      const syncServer = options?.syncServer ?? true
      let merged: Contact[] = []
      setContacts((current) => {
        merged = mergeContacts(current, [normalized])
        return merged
      })
      await saveContactsToDb([normalized])
      if (merged.length > 0) {
        await persistContacts(merged, syncServer)
      }
    },
    [persistContacts, saveContactsToDb]
  )

  const addContactByHandle = React.useCallback(
    async (handleInput: string) => {
      const normalizedHandle = normalizeHandle(handleInput)
      const parts = splitHandle(normalizedHandle)
      if (!parts) {
        throw new Error("Enter a valid handle like user@server.com")
      }
      const entry = await apiFetch<{
        handle?: string
        public_identity_key: string
        public_transport_key: string
        display_name?: string | null
      }>(`/api/directory?handle=${encodeURIComponent(normalizedHandle)}`)
      const handle = entry.handle ?? normalizedHandle
      const handleParts = splitHandle(handle) ?? parts
      const trimmedDisplayName = entry.display_name?.trim() ?? ""
      const contact: Contact = {
        handle,
        username: trimmedDisplayName.length > 0 ? trimmedDisplayName : handleParts.username,
        host: handleParts.host,
        publicIdentityKey: entry.public_identity_key,
        publicTransportKey: entry.public_transport_key,
        createdAt: new Date().toISOString(),
      }
      await addContact(contact)
      return contact
    },
    [addContact]
  )

  const removeContact = React.useCallback(
    async (handleInput: string) => {
      const normalized = normalizeHandle(handleInput).toLowerCase()
      let nextContacts: Contact[] = []
      setContacts((current) => {
        nextContacts = current.filter(
          (contact) => contact.handle.toLowerCase() !== normalized
        )
        return nextContacts
      })
      await db.contacts.delete(normalizeHandle(handleInput))
      await persistContacts(nextContacts, true)
    },
    [persistContacts]
  )

  const applyEncryptedContacts = React.useCallback(
    async (encrypted: EncryptedPayload | null) => {
      if (!encrypted) {
        setContacts([])
        await db.syncState.delete(CONTACTS_KEY)
        if (user?.handle) {
          const ownerId = user.id ?? user.handle
          await deleteMissingContacts(ownerId, new Set())
        }
        return
      }

      await db.syncState.put({ key: CONTACTS_KEY, value: encrypted })

      if (!masterKey) {
        return
      }

      try {
        const decrypted = await decryptString(masterKey, encrypted)
        const parsed = JSON.parse(decrypted) as ContactsPayload
        const incoming = Array.isArray(parsed.contacts) ? parsed.contacts : []
        const normalized = mergeContacts([], incoming)
        setContacts(normalized)
        await saveContactsToDb(normalized)
        if (user?.handle) {
          const ownerId = user.id ?? user.handle
          const keep = new Set(
            normalized.map((contact) => contact.handle.toLowerCase())
          )
          await deleteMissingContacts(ownerId, keep)
        }
      } catch (error) {
        console.error("Failed to decrypt contacts:", error)
      }
    },
    [masterKey, saveContactsToDb, user?.handle, user?.id]
  )

  const refreshContacts = React.useCallback(async () => {
    if (status !== "authenticated" || !masterKey || !user?.handle) {
      setContacts([])
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    const ownerId = user.id ?? user.handle
    try {
      const localRecords = await db.contacts
        .where("ownerId")
        .equals(ownerId)
        .toArray()
      const localContacts = (
        await Promise.all(
          localRecords.map((record) => decodeContactRecord(record, masterKey))
        )
      ).filter(Boolean) as Contact[]

      let encrypted: EncryptedPayload | null = null
      let serverContacts: Contact[] = []
      let serverHasData = false

      const serverData = await apiFetch<{
        ciphertext: string | null
        iv: string | null
      }>("/auth/contacts").catch(() => null)

      if (serverData?.ciphertext && serverData?.iv) {
        encrypted = { ciphertext: serverData.ciphertext, iv: serverData.iv }
        serverHasData = true
      } else {
        const record = await db.syncState.get(CONTACTS_KEY)
        if (record?.value) {
          encrypted = record.value as EncryptedPayload
        }
      }

      if (encrypted) {
        try {
          const decrypted = await decryptString(masterKey, encrypted)
          const parsed = JSON.parse(decrypted) as ContactsPayload
          serverContacts = Array.isArray(parsed.contacts) ? parsed.contacts : []
        } catch {
          serverContacts = []
        }
      }

      let nextContacts = localContacts
      if (encrypted && serverHasData) {
        nextContacts = mergeContacts([], serverContacts)
      } else if (encrypted) {
        nextContacts = mergeContacts(localContacts, serverContacts)
      }
      setContacts(nextContacts)
      await saveContactsToDb(nextContacts)
      if (encrypted && serverHasData) {
        const keep = new Set(
          nextContacts.map((contact) => contact.handle.toLowerCase())
        )
        await deleteMissingContacts(ownerId, keep)
      }

      if (!serverHasData) {
        const shouldSyncServer =
          !encrypted ||
          (serverContacts.length > 0 &&
            !contactsEqual(serverContacts, nextContacts)) ||
          (serverContacts.length === 0 && nextContacts.length > 0)
        if (nextContacts.length > 0) {
          await persistContacts(nextContacts, shouldSyncServer)
        } else if (encrypted) {
          await db.syncState.put({ key: CONTACTS_KEY, value: encrypted })
        }
      } else if (encrypted) {
        await db.syncState.put({ key: CONTACTS_KEY, value: encrypted })
      }
    } finally {
      setIsLoading(false)
    }
  }, [masterKey, persistContacts, saveContactsToDb, status, user?.handle, user?.id])

  React.useEffect(() => {
    void refreshContacts()
  }, [refreshContacts])

  const value = React.useMemo<ContactsContextValue>(
    () => ({
      contacts,
      isLoading,
      addContact,
      addContactByHandle,
      removeContact,
      refreshContacts,
      applyEncryptedContacts,
    }),
    [
      contacts,
      isLoading,
      addContact,
      addContactByHandle,
      removeContact,
      refreshContacts,
      applyEncryptedContacts,
    ]
  )

  return (
    <ContactsContext.Provider value={value}>
      {children}
    </ContactsContext.Provider>
  )
}

export function useContacts(): ContactsContextValue {
  const context = React.useContext(ContactsContext)
  if (!context) {
    throw new Error("useContacts must be used within a ContactsProvider")
  }
  return context
}
