# Ratchet Chat Server API

This server implements a blind drop-box with a strict two-bucket storage pattern:
- IncomingQueue: transit payloads encrypted to the recipient's public transport key.
- MessageVault: storage payloads encrypted to the recipient's client-side AES key.

The server never receives plaintext messages, raw passwords, or private keys.

## Authentication

- JWT is required for all endpoints except `POST /auth/register`, `GET /auth/params/:username`,
  `POST /auth/login`, `POST /auth/srp/start`, `POST /auth/srp/verify`,
  `GET /directory/:handle`, `GET /api/directory`, `GET /api/federation/key`,
  `POST /api/federation/incoming`.
- Send the token using `Authorization: Bearer <jwt>`.
- JWT subject (`sub`) is the user id.

Common errors:
- 400 Invalid request
- 401 Unauthorized
- 403 Forbidden
- 404 Not found
- 409 Conflict (username already taken)

## Data expectations

- All `id` fields are UUID strings.
- `handle` is a `username@host` string (e.g. `alice@example.com`).
- `encrypted_blob` is opaque data (Base64 or other safe string encoding).
- `public_identity_key` is a Base64 Ed25519 public key.
- `public_transport_key` is a Base64 RSA/X25519 public key.
- The server does not verify cryptographic claims beyond basic type checks.

## Endpoints

### Group 0: Authentication & Account

#### POST /auth/register
Registers a user and stores public keys.

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

Response:
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

### Group 1: Identity & Directory (Public)

#### GET /.well-known/ratchet-chat/federation.json
Federation discovery document used for trust/pinning and endpoint discovery.

Response:
```json
{
  "host": "ratchet.example.com",
  "version": 1,
  "inbox_url": "/api/federation/incoming",
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

#### GET /directory/:handle
Returns public keys and id for a handle. If the handle belongs to a remote
host, this server performs the federation lookup and relays the result.

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

#### GET /api/federation/key
Returns this server's federation public key for callback verification.

Response:
```json
{
  "host": "api.example.com",
  "publicKey": "base64"
}
```

### Group 2: Transit Flow (Auth required)

#### POST /messages/send
Stores an encrypted transit payload in the IncomingQueue (local) or relays to
the remote host based on `recipient_handle`.

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

Response:
```json
{
  "id": "uuid",
  "recipient_handle": "bob@remote.host",
  "created_at": "2024-01-01T00:00:00.000Z",
  "relayed": false
}
```


#### POST /api/federation/incoming
Federation endpoint used by remote hosts to enqueue a message.

Security:
- Callback verification is required. Include `X-Ratchet-Host` and `X-Ratchet-Sig`
  headers and sign the JSON payload with the sender host's Ed25519 private key.

Request body:
```json
{
  "recipient_handle": "bob@local.host",
  "sender_handle": "alice@remote.host",
  "encrypted_blob": "opaque-string"
}
```

Response:
```json
{
  "id": "uuid",
  "recipient_handle": "bob@local.host",
  "created_at": "2024-01-01T00:00:00.000Z"
}
```

### Group 3: Bridge Flow (Auth required)

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

#### POST /messages/queue/:id/store
Stores a decrypted-and-reencrypted message into the MessageVault and removes it
from the IncomingQueue in a single operation. Only queue items owned by the
authenticated user can be stored.

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

#### POST /messages/queue/:id/ack
Acknowledges and deletes a queue item without storing it in the MessageVault.
Used for non-message events (e.g., receipt updates) once verified client-side.

Response:
```json
{
  "ok": true
}
```

#### DELETE /messages/queue/:id
This endpoint is no longer supported. Messages are only removed from the queue
when stored via `POST /messages/queue/:id/store`.

#### POST /messages/vault
Stores a message encrypted with the client's AES key in the MessageVault.

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

### Group 4: Storage Flow (Auth required)

#### GET /messages/vault
Returns MessageVault items for the authenticated user (newest-first by default).

Query params:
- `order`: `desc` (default) or `asc`
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

#### PATCH /messages/vault/:id
Updates the encrypted payload for an existing MessageVault entry (used to store
updated delivery/processed/read timestamps).

Request body:
```json
{
  "encrypted_blob": "opaque-string",
  "iv": "base64-iv"
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

### Group 5: User Settings (Auth required)

#### GET /auth/settings
Retrieves current user preferences.

Response:
```json
{
  "showTypingIndicator": true,
  "sendReadReceipts": true
}
```

#### PATCH /auth/settings
Updates user preferences.

Request body:
```json
{
  "showTypingIndicator": false,
  "sendReadReceipts": true
}
```

Response:
```json
{
  "showTypingIndicator": false,
  "sendReadReceipts": true
}
```

## WebSocket API (Socket.io)

Authentication is handled via handshake auth: `{ token: "Bearer <jwt>" }`.

### Server-to-Client Events

- `INCOMING_MESSAGE`: Emitted when a new message is enqueued for the user.
  ```json
  {
    "id": "uuid",
    "message_id": "uuid",
    "recipient_id": "uuid",
    "sender_handle": "alice@host",
    "encrypted_blob": "base64",
    "created_at": "ISO-8601"
  }
  ```

- `signal`: Ephemeral signaling (e.g. typing indicators).
  ```json
  {
    "sender_handle": "alice@host",
    "encrypted_blob": "base64-encrypted-to-transport-key"
  }
  ```

### Client-to-Server Events

- `signal`: Sends an ephemeral signal to a connected local user.
  ```json
  {
    "recipient_handle": "bob@host",
    "encrypted_blob": "base64-encrypted-to-transport-key"
  }
  ```

## What the server expects from the client

Identity and authentication:
- Generate identity and transport key pairs client-side.
- Provide only public keys at registration.
- Use a strong password; the server stores only a hash.

Transit flow:
- Encrypt message payloads with the recipient's public transport key.
- Upload the transit payload to `/messages/send`.
- Do not send plaintext or private keys.

Bridge flow (client-driven only):
- Pull from `/messages/queue`.
- Decrypt using the recipient's private transport key.
- Verify the sender signature using the sender's public identity key.
- Re-encrypt the message with the recipient's AES key (client-derived).
- Upload to `/messages/queue/:id/store` with the new ciphertext and `iv`.

Receipts:
- Send signed receipt events (`PROCESSED_BY_CLIENT`, `READ_BY_USER`) as encrypted
  transit messages via `/messages/send`.
- Store receipt timestamps with the original message payload (client-side
  encryption) and update the MessageVault via `PATCH /messages/vault/:id`.
