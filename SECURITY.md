# Security Policy

## Supported Versions

Only the latest version of Ratchet Chat is currently supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1.0 | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability within Ratchet Chat, please report it privately. Do **NOT** open a public GitHub issue.

### Process

1.  **Email:** Send an email to `security@ratchet.chat` (replace with actual security contact if available, otherwise use project maintainer).
2.  **Details:** Please include as much detail as possible:
    *   Type of vulnerability (e.g., XSS, SQLi, E2EE bypass).
    *   Steps to reproduce.
    *   Impact assessment.
    *   Proof of Concept (PoC) code or screenshots.
3.  **Response:** We will acknowledge your report within 48 hours and provide an estimated timeline for a fix.

## Security Architecture

Ratchet Chat is designed with a "privacy-by-design" philosophy.

### End-to-End Encryption (E2EE)
*   **Protocol:** Messages are encrypted on the client device using a hybrid scheme (RSA-OAEP for transport key exchange + AES-GCM for payload encryption).
*   **Zero Knowledge:** The server stores only encrypted blobs (`encrypted_blob`) and initialization vectors (`iv`). It does not possess the private keys required to decrypt user messages.
*   **Key Management:** Private keys are stored locally in the browser (IndexedDB), encrypted with a master key derived from the user's password (PBKDF2).

### Authentication
*   **SRP (Secure Remote Password):** We use the SRP-6a protocol for password authentication. The server never sees or stores the user's plain-text password, only a verifier.
*   **JWT:** Post-authentication sessions are managed via JSON Web Tokens.

### Federation Security
*   **TOFU (Trust On First Use):** Federated identities are trusted on the first connection.
*   **Signatures:** All federated messages are signed using Ed25519 keys to ensure authenticity.
*   **Allowlist:** Federation can be restricted to specific hosts via environment variables.

## Known Limitations / Threat Model

*   **Metadata:** The server knows *who* is messaging *whom* and *when* (metadata), but not *what* they are saying.
*   **Client Security:** The security of the E2EE scheme relies on the security of the user's device. Malware on the client device could compromise keys or messages.
*   **Federation Trust:** The current TOFU model for federation means a sophisticated Man-in-the-Middle (MitM) attack during the very first exchange could theoretically compromise a federated session.