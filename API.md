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
- Rate limits apply to auth, federation, and log ingestion endpoints (`429`).

## Authentication

- JWT is required for all protected endpoints (marked below).
- Send as: `Authorization: Bearer <jwt>`.
- JWT `sub` is the user id; `username` is also encoded in the token.
- Socket.IO auth uses the same JWT (see Realtime section).
- Password authentication uses SRP-6a (`/auth/srp/*`) and never sends plaintext
  passwords to the server.

## Server API

### Auth (public)

#### POST /auth/register

Registers a new local user and stores encrypted private keys and public keys.

Request body:
```json
{
  "username": "alice",
  "kdf_salt": "base64",
  "kdf_iterations": 310000,
  "public_identity_key": "base64",
  "public_transport_key": "base64",
  "encrypted_identity_key": "base64",
  "encrypted_identity_iv": "base64",
  "encrypted_transport_key": "base64",
  "encrypted_transport_iv": "base64",
  "srp_salt": "base64",
  "srp_verifier": "base64"
}
```

Notes:
- `username` must be local (no `@`), length 3-64.
- `kdf_*` fields are used client-side to derive the master key; the server stores them for later login.
- The server enforces minimum/maximum iteration counts for `kdf_iterations`.
- `srp_salt` and `srp_verifier` are used for SRP-6a login.

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

Returns key-derivation parameters for a local username (used to derive the
client master key).

Response:
```json
{
  "kdf_salt": "base64",
  "kdf_iterations": 310000
}
```

#### POST /auth/login

Deprecated. Use SRP login endpoints.

Response:
```json
{
  "error": "Use SRP login endpoints"
}
```

#### POST /auth/srp/start

Starts SRP-6a login by accepting the client ephemeral `A` and returning the SRP
salt and server ephemeral `B`.

Request body:
```json
{
  "username": "alice",
  "A": "base64"
}
```

Response:
```json
{
  "salt": "base64",
  "B": "base64"
}
```

#### POST /auth/srp/verify

Completes SRP-6a login by verifying the client proof `M1`. Returns JWT, encrypted
keys, and server proof `M2` so the client can verify the server.

Request body:
```json
{
  "username": "alice",
  "A": "base64",
  "M1": "base64"
}
```

Response:
```json
{
  "token": "jwt",
  "M2": "base64",
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

#### GET /.well-known/ratchet-chat/federation.json

Federation discovery document used for trust/pinning and endpoint discovery.

Response:
```json
{
  "host": "ratchet.example.com",
  "version": 1,
  "inbox_url": "/api/federation/incoming",
  "receipts_url": "/api/federation/receipts",
  "directory_url": "/directory",
  "keys": [
    {
      "kid": "base64url",
      "public_key": "base64",
      "status": "active",
      "created_at": "2024-01-01T00:00:00.000Z",
      "expires_at": null
    }
  ],
  "generated_at": "2024-01-01T00:00:00.000Z",
  "signature": "base64",
  "signature_kid": "base64url"
}
```

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
- Rejects hosts that resolve to private/reserved IPs in production or that are not
  in the configured allowlist (if set).
- Detects replayed payloads and returns `409`.

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

Behavior:
- Verifies signature via callback to `https://<X-Ratchet-Host>/api/federation/key`
  in production; http is allowed for localhost in development.
- Rejects hosts that resolve to private/reserved IPs in production or that are not
  in the configured allowlist (if set).
- Detects replayed payloads and returns `409`.

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
