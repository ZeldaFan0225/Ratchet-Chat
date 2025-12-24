# Ratchet Chat Server API

This server implements a blind drop-box with a strict two-bucket storage pattern:
- IncomingQueue: transit payloads encrypted to the recipient's public transport key.
- MessageVault: storage payloads encrypted to the recipient's client-side AES key.

The server never receives plaintext messages, raw passwords, or private keys.

## Authentication

- JWT is required for all endpoints except `POST /auth/register`, `GET /auth/params/:username`,
  `POST /auth/login`, `GET /directory/:handle`, `GET /api/directory`,
  `GET /api/federation/key`, `POST /api/federation/incoming`, and
  `POST /api/federation/receipts`.
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
- The server does not validate cryptographic material beyond basic type checks.

## Endpoints

### Group 0: Public

#### POST /auth/register
Registers a user and stores public keys.

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
Returns authentication and key-derivation parameters for a local username.

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
Authenticates and returns a JWT.

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

### Group 1: Identity & Directory (Public)

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

Side effect:
- Creates a Receipt of type `DELIVERED_TO_SERVER` for the sender.

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

#### POST /api/federation/receipts
Federation endpoint used by remote hosts to deliver read/processed receipts.

Security:
- Callback verification is required. Include `X-Ratchet-Host` and `X-Ratchet-Sig`
  headers and sign the JSON payload with the sender host's Ed25519 private key.

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

### Group 4: Storage Flow & Receipts (Auth required)

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

#### POST /receipts
Creates a receipt.

Request body:
```json
{
  "recipient_id": "uuid",
  "recipient_handle": "alice@local.host",
  "message_id": "uuid",
  "type": "DELIVERED_TO_SERVER"
}
```

Response:
```json
{
  "id": "uuid",
  "recipient_id": "uuid",
  "message_id": "uuid",
  "type": "DELIVERED_TO_SERVER",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

#### GET /receipts
Returns receipts for the authenticated user.

Query params:
- `since`: ISO timestamp; returns receipts after this time.

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
- Create receipts when appropriate (`PROCESSED_BY_CLIENT`, `READ_BY_USER`).
- If `recipient_handle` is remote, the server forwards to the recipient's host
  via `POST /federation/receipts`.
- Treat receipt delivery as metadata only; the server does not verify cryptographic claims.
