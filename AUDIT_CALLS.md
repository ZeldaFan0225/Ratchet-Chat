# Security Assessment: Audio & Video Calling

**Date:** December 27, 2025
**Scope:** Audio/Video Calling Feature (Client & Server)

## Executive Summary
The audio/video calling feature in Ratchet Chat implements strong end-to-end encryption for signaling messages, ensuring that the server cannot intercept the WebRTC connection parameters (SDP and ICE candidates). This is a significant privacy feature. However, the system currently lacks a mechanism for users to verify the identity of their peer (e.g., a "Safety Number" or key fingerprint), leaving it vulnerable to a sophisticated active Man-in-the-Middle (MITM) attack by a compromised server. Additionally, the reliance on public STUN servers exposes user IP addresses to third parties (Google).

## Detailed Findings

### 1. Signaling Security (Strength: High)
-   **Mechanism:** Signaling messages (SDP offers/answers, ICE candidates) are encrypted on the client side before transmission.
-   **Cryptography:** Uses a hybrid scheme:
    -   **AES-GCM (256-bit)** for payload encryption.
    -   **RSA-OAEP (2048-bit)** for key exchange.
-   **Impact:** The server acts as a blind relay. It knows *who* is calling *whom* and *when*, but cannot see the technical details of the connection or inject malicious ICE candidates to redirect media traffic without detection (assuming key integrity).

### 2. Transport Security (Strength: Standard)
-   **Mechanism:** WebRTC enforces encryption for media streams (audio/video) and data channels.
-   **Protocol:** Uses DTLS (Datagram Transport Layer Security) and SRTP (Secure Real-time Transport Protocol).
-   **Impact:** Media data is encrypted in transit between peers.

### 3. Identity & Authentication (Strength: Medium/Low)
-   **Authentication:** WebSocket connections are authenticated via JWT.
    -   **Vulnerability:** JWT tokens are passed in the URL query string (`wss://...?token=...`). This can lead to token leakage in server logs, proxy logs, or browser history.
-   **Identity Verification (Critical Gap):** The client implicitly trusts the public key provided by the server in the `call:incoming` message.
    -   **Risk:** A compromised server could substitute the legitimate recipient's public key with its own, successfully performing a MITM attack on the signaling channel and thus the media stream.
    -   **Recommendation:** Implement a "Safety Number" or "Key Fingerprint" verification UI that allows users to manually verify they are using the correct keys.

### 4. Privacy & Metadata (Strength: Low)
-   **ICE Servers:** The application uses Google's public STUN servers (`stun.l.google.com`).
    -   **Risk:** User IP addresses are exposed to Google during call setup.
    -   **Recommendation:** Deploy a self-hosted TURN/STUN server (e.g., Coturn) to mask user IP addresses and ensure connectivity in restrictive network environments.

## Recommendations

### Critical Priority
1.  **Implement Identity Verification:** Add a visual indicator (fingerprint/safety number) in the call overlay that users can compare out-of-band to verify the integrity of the end-to-end encryption.
2.  **Move Token to Header:** Refactor the WebSocket connection to pass the authentication token in a specialized header or the initial handshake protocol, rather than the URL query string, to prevent logging leaks.

### High Priority
1.  **Deploy Private TURN Server:** Replace public Google STUN servers with a self-hosted TURN server to protect user privacy and improve connection reliability.

### Medium Priority
1.  **Key Pinning/TOFU:** Implement Trust On First Use (TOFU) or key pinning to alert users if a contact's key changes unexpectedly.
