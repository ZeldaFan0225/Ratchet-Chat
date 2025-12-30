export type Attachment = {
  filename: string
  mimeType: string
  size: number
  data: string // Base64
}

export type Contact = {
  handle: string
  username: string
  nickname?: string | null
  host: string
  publicIdentityKey: string
  publicTransportKey: string
  avatar_filename?: string | null
  createdAt?: string
}

export type ReactionSummary = {
  emoji: string
  count: number
  reactedByMe: boolean
}

export type StoredMessage = {
  id: string
  peerHandle: string
  peerUsername?: string
  peerHost?: string
  peerIdentityKey?: string
  peerTransportKey?: string
  direction: "in" | "out"
  text: string
  attachments?: Attachment[]
  timestamp: string
  kind?: "message" | "edit" | "delete" | "reaction" | "call"
  callEventType?: "CALL_STARTED" | "CALL_ENDED" | "CALL_MISSED" | "CALL_DECLINED"
  callType?: "AUDIO" | "VIDEO"
  callDirection?: "incoming" | "outgoing"
  callDurationSeconds?: number
  editedAt?: string
  deletedAt?: string
  reactionAction?: "add" | "remove"
  deliveredAt?: string
  processedAt?: string
  readAt?: string
  replyTo?: {
    messageId: string
  }
  reactions?: ReactionSummary[]
  verified: boolean
  isRead: boolean
  messageId?: string
  isMessageRequest?: boolean
}

export type DirectoryEntry = {
  id?: string
  handle: string
  host: string
  public_identity_key: string
  public_transport_key: string
  display_name?: string | null
  avatar_filename?: string | null
}
