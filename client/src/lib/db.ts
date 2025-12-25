import Dexie, { type Table } from "dexie"

export type ContactRecord = {
  id: string
  ownerId: string
  content: string
  createdAt: string
}

export type MessageRecord = {
  id: string
  ownerId: string
  senderId: string
  content: string
  verified: boolean
  createdAt: string
  isRead?: boolean
  vaultSynced?: boolean
}

export class RatchetDB extends Dexie {
  messages!: Table<MessageRecord, string>
  contacts!: Table<ContactRecord, string>
  auth!: Table<AuthRecord, string>
  syncState!: Table<SyncStateRecord, string>

  constructor() {
    super("RatchetChat")
    this.version(1).stores({
      messages: "&id, ownerId, senderId, createdAt",
    })
    this.version(2)
      .stores({
        messages: "&id, ownerId, senderId, createdAt, isRead",
      })
      .upgrade((tx) =>
        tx
          .table<MessageRecord, string>("messages")
          .toCollection()
          .modify((message) => {
            if (message.isRead === undefined) {
              message.isRead = true
            }
          })
      )
    this.version(3)
      .stores({
        messages:
          "&id, ownerId, senderId, createdAt, isRead, receiptStatus, readReceiptSent",
      })
      .upgrade((tx) =>
        tx
          .table("messages")
          .toCollection()
          .modify((message: { readReceiptSent?: boolean }) => {
            if (message.readReceiptSent === undefined) {
              message.readReceiptSent = false
            }
          })
      )
    this.version(4).stores({
      messages:
        "&id, ownerId, senderId, createdAt, isRead",
      contacts: "&id, ownerId, createdAt",
    })
    this.version(5).stores({
      messages:
        "&id, ownerId, senderId, createdAt, isRead, vaultSynced",
      contacts: "&id, ownerId, createdAt",
    })
    this.version(6).stores({
      messages:
        "&id, ownerId, senderId, createdAt, isRead, vaultSynced",
      contacts: "&id, ownerId, createdAt",
      auth: "&username",
      syncState: "&key",
    })
    this.version(7)
      .stores({
        messages: "&id, ownerId, senderId, createdAt, isRead, vaultSynced",
        contacts: "&id, ownerId, createdAt",
        auth: "&username",
        syncState: "&key",
      })
      .upgrade((tx) =>
        tx
          .table<MessageRecord, string>("messages")
          .toCollection()
          .modify((message) => {
            delete (message as { receiptStatus?: unknown }).receiptStatus
            delete (message as { readReceiptSent?: unknown }).readReceiptSent
          })
      )
  }
}

export type AuthRecord = {
  username: string
  data: unknown // JSON object for stored keys/tokens
}

export type SyncStateRecord = {
  key: string
  value: unknown
}

export const db = new RatchetDB()
