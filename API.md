# Ratchet Chat API

This document lists every HTTP endpoint and realtime event used by the Ratchet Chat
server and client applications. All JSON examples are illustrative; omit optional
fields as described per endpoint.

## Base URLs

- Server API base: `https://<server-host>` (example: `https://ratchet.example.com`)
- Client (Next.js) API base: `https://<client-host>` (example: `https://ratchet-client.example.com`)

## Conventions

- Content-Type: `application/json` for all request bodies.
- IDs: UUID strings.
- Handle format: `username@host` (host may include `:port`).
- Host validation pattern: `[A-Za-z0-9.-]+(:port)?` (no scheme).
- Receipt types: `DELIVERED_TO_SERVER`, `PROCESSED_BY_CLIENT`, `READ_BY_USER`.
- Error shape: `{ "error": "message" }` with an appropriate status code.
- Server JSON body limit: 2 MB.

## Authentication

- JWT is required for all protected endpoints (marked below).
- Send as: `Authorization: Bearer <jwt>`.
- JWT `sub` is the user id; `username` is also encoded in the token.
- Socket.IO auth uses the same JWT (see Realtime section).

## Server API

### Auth (public)

#### POST /auth/register

Registers a new local user and stores encrypted private keys and public keys.

Request body:
```json
{
  "username": "alice",
  "auth_hash": "base64",
  "auth_salt": "base64",
  "auth_iterations": 200000,
  "kdf_salt": "base64",
  "kdf_iterations": 310000,
  "public_identity_key": "base64",
  "public_transport_key": "base64",
  "encrypted_identity_key": "base64",
  "encrypted_identity_iv": "base64",
  "encrypted_transport_key": "base64",
  "encrypted_transport_iv": "base64"
}
```

Notes:
- `username` must be local (no `@`), length 3-64.
- `auth_hash` is derived client-side using PBKDF2 with `auth_salt` and `auth_iterations`.
- `kdf_*` fields are used client-side to derive the master key; the server stores them for later login.

Responses:
- `201`:
```json
{
  "user": {
    "id": "uuid",
    "username": "alice",
    "created_at": "2024-01-01T00:00:00.000Z",
    "public_identity_key": "base64",
    "public_transport_key": "base64"
  }
}
```
- `409` if username already taken.

#### GET /auth/params/:username

Returns authentication and KDF parameters for a local username.

Response:
```json
{
  "auth_salt": "base64",
  "auth_iterations": 200000,
  "kdf_salt": "base64",
  "kdf_iterations": 310000
}
```

#### POST /auth/login

Authenticates a local user and returns a JWT plus encrypted private keys.

Request body:
```json
{
  "username": "alice",
  "auth_hash": "base64"
}
```

Response:
```json
{
  "token": "jwt",
  "keys": {
    "encrypted_identity_key": "base64",
    "encrypted_identity_iv": "base64",
    "encrypted_transport_key": "base64",
    "encrypted_transport_iv": "base64",
    "kdf_salt": "base64",
    "kdf_iterations": 310000,
    "public_identity_key": "base64",
    "public_transport_key": "base64"
  }
}
```

### Directory (public)

#### GET /directory/:handle

Returns public keys for a handle. If the handle is remote, the server performs a
federation directory lookup and proxies the result.

Response:
```json
{
  "id": "uuid",
  "handle": "alice@example.com",
  "host": "example.com",
  "public_identity_key": "base64",
  "public_transport_key": "base64"
}
```

#### GET /directory?handle=alice@example.com

Same response and behavior as `/directory/:handle`.

#### GET /api/directory?handle=alice@example.com

Same response and behavior as `/directory/:handle`.

### Federation (public, server-to-server)

#### GET /api/federation/key

Returns this server's federation identity.

Response:
```json
{
  "host": "ratchet.example.com",
  "publicKey": "base64"
}
```

#### POST /api/federation/incoming
#### POST /federation/incoming

Remote host enqueues a transit message for a local recipient.

Headers:
- `X-Ratchet-Host`: sender host (no scheme, e.g. `chat.remote.com`)
- `X-Ratchet-Sig`: Base64 Ed25519 signature of `JSON.stringify(body)`

Request body:
```json
{
  "recipient_handle": "bob@local.host",
  "sender_handle": "alice@remote.host",
  "encrypted_blob": "opaque-string"
}
```

Behavior:
- Verifies signature via callback to `https://<X-Ratchet-Host>/api/federation/key`
  in production; http is allowed for localhost in development.
- Rejects if `sender_handle` host does not match `X-Ratchet-Host`.

Response:
```json
{
  "id": "uuid",
  "recipient_handle": "bob@local.host",
  "created_at": "2024-01-01T00:00:00.000Z"
}
```

#### POST /api/federation/receipts
#### POST /federation/receipts

Remote host delivers a receipt for a local recipient.

Headers:
- `X-Ratchet-Host`: sender host
- `X-Ratchet-Sig`: Base64 Ed25519 signature of `JSON.stringify(body)`

Request body:
```json
{
  "recipient_handle": "alice@local.host",
  "message_id": "uuid",
  "type": "READ_BY_USER"
}
```

Response:
```json
{
  "id": "uuid",
  "recipient_id": "uuid",
  "message_id": "uuid",
  "type": "READ_BY_USER",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### Messages (protected)

#### POST /messages/send

Stores an encrypted transit payload in IncomingQueue (local recipient) or relays
to a remote host (remote recipient). Also optionally stores a sender vault copy.

Request body:
```json
{
  "recipient_handle": "bob@remote.host",
  "encrypted_blob": "opaque-string",
  "message_id": "uuid",
  "sender_vault_blob": "opaque-string",
  "sender_vault_iv": "base64-iv",
  "sender_vault_signature_verified": true
}
```

Behavior:
- If `recipient_handle` is local: enqueue in IncomingQueue and return `201`.
- If remote: sign and forward to `POST /api/federation/incoming` on the remote
  host and return `202` if accepted.
- If `sender_vault_*` is provided, the server stores a local copy for the sender.

Local response (`201`):
```json
{
  "id": "uuid",
  "recipient_handle": "bob@local.host",
  "created_at": "2024-01-01T00:00:00.000Z",
  "relayed": false,
  "sender_vault_stored": true
}
```

Remote response (`202`):
```json
{
  "recipient_handle": "bob@remote.host",
  "relayed": true,
  "sender_vault_stored": true
}
```

#### GET /messages/queue

Returns all IncomingQueue items for the authenticated user.

Response:
```json
[
  {
    "id": "uuid",
    "recipient_id": "uuid",
    "sender_handle": "alice@remote.host",
    "encrypted_blob": "opaque-string",
    "created_at": "2024-01-01T00:00:00.000Z"
  }
]
```

#### DELETE /messages/queue/:id

Always returns `405`. Use `POST /messages/queue/:id/store` instead.

#### POST /messages/queue/:id/store

Stores a decrypted-and-reencrypted message into MessageVault and removes it
from IncomingQueue in a single transaction.

Request body:
```json
{
  "encrypted_blob": "opaque-string",
  "iv": "base64-iv",
  "sender_signature_verified": true
}
```

Response:
```json
{
  "id": "uuid",
  "owner_id": "uuid",
  "original_sender_handle": "alice@remote.host",
  "encrypted_blob": "opaque-string",
  "iv": "base64-iv",
  "sender_signature_verified": true,
  "created_at": "2024-01-01T00:00:00.000Z"
}
```

#### POST /messages/vault

Stores a message encrypted with the client's master key in MessageVault.

Request body:
```json
{
  "message_id": "uuid",
  "encrypted_blob": "opaque-string",
  "iv": "base64-iv",
  "original_sender_handle": "alice@remote.host",
  "sender_signature_verified": true
}
```

Behavior:
- If `message_id` already exists for this user, returns the existing entry (`200`).
- Otherwise creates a new entry (`201`).

Response:
```json
{
  "id": "uuid",
  "owner_id": "uuid",
  "original_sender_handle": "alice@remote.host",
  "encrypted_blob": "opaque-string",
  "iv": "base64-iv",
  "sender_signature_verified": true,
  "created_at": "2024-01-01T00:00:00.000Z"
}
```

#### GET /messages/vault

Returns MessageVault items for the authenticated user.

Query params:
- `order`: `asc` or `desc` (default `desc`)
- `limit`: optional integer max results

Response:
```json
[
  {
    "id": "uuid",
    "owner_id": "uuid",
    "original_sender_handle": "alice@remote.host",
    "encrypted_blob": "opaque-string",
    "iv": "base64-iv",
    "sender_signature_verified": true,
    "created_at": "2024-01-01T00:00:00.000Z"
  }
]
```

#### POST /messages/vault/delete-chat

Deletes all MessageVault entries for a peer handle.

Request body:
```json
{
  "peer_handle": "alice@remote.host"
}
```

Response:
```json
{
  "count": 12
}
```

### Receipts (protected)

#### POST /receipts

Creates a receipt for a local recipient or relays to a remote host if
`recipient_handle` is remote.

Request body:
```json
{
  "recipient_id": "uuid",
  "recipient_handle": "alice@remote.host",
  "message_id": "uuid",
  "type": "DELIVERED_TO_SERVER"
}
```

Behavior:
- Supply either `recipient_id` or `recipient_handle`.
- If `recipient_handle` is remote, the server signs and forwards to
  `POST /api/federation/receipts` on the remote host and returns `202`.

Local response (`201`):
```json
{
  "id": "uuid",
  "recipient_id": "uuid",
  "message_id": "uuid",
  "type": "DELIVERED_TO_SERVER",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

Remote response (`202`):
```json
{
  "relayed": true
}
```

#### GET /receipts

Returns receipts for the authenticated user.

Query params:
- `since`: ISO timestamp; returns receipts after this time

Response:
```json
[
  {
    "id": "uuid",
    "recipient_id": "uuid",
    "message_id": "uuid",
    "type": "DELIVERED_TO_SERVER",
    "timestamp": "2024-01-01T00:00:00.000Z"
  }
]
```

## Realtime (Socket.IO on the server)

### Connection

- URL: server base URL (e.g. `https://ratchet.example.com`)
- Auth: include `auth: { token: "Bearer <jwt>" }` or query `?token=Bearer <jwt>`.

### Events (server -> client)

#### INCOMING_MESSAGE
```json
{
  "id": "uuid",
  "message_id": "uuid",
  "recipient_id": "uuid",
  "sender_handle": "alice@remote.host",
  "encrypted_blob": "opaque-string",
  "created_at": "2024-01-01T00:00:00.000Z"
}
```

#### RECEIPT_UPDATE
```json
{
  "message_id": "uuid",
  "type": "READ_BY_USER",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Client (Next.js) API

### POST /api/logs

Receives client-side logs and writes them to the client log file.

Headers:
- `Origin` must match `NEXT_PUBLIC_APP_URL` prefix if configured.
- `Content-Type: application/json`

Request body:
```json
{
  "level": "info",
  "event": "message.send.prepared",
  "payload": { "message_id": "uuid" },
  "context": { "route": "/messages/send" },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

Behavior:
- Rejects payloads larger than `CLIENT_LOG_MAX_BYTES` (default 200000 bytes).
- Redacts sensitive keys before writing logs.

Response:
```json
{
  "ok": true
}
```
