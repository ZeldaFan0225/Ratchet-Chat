import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  VerifiedRegistrationResponse,
  VerifiedAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import { getServerHost } from "./federationAuth";

// Challenge cache with expiration (5 minutes)
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const challengeCache = new Map<string, { challenge: string; expiresAt: number }>();

// Clean expired challenges periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of challengeCache.entries()) {
    if (value.expiresAt < now) {
      challengeCache.delete(key);
    }
  }
}, 60 * 1000);

const getRpId = (): string => {
  const candidate =
    process.env.CLIENT_URL ??
    process.env.CLIENT_ORIGIN ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "";
  if (candidate) {
    try {
      return new URL(candidate).hostname;
    } catch {
      return candidate.replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
    }
  }
  const host = getServerHost();
  return host.split(":")[0];
};

const getRpName = (): string => {
  return process.env.RP_NAME ?? "Ratchet Chat";
};

const getExpectedOrigins = (): string[] => {
  const origins: string[] = [];

  // Primary: CLIENT_URL from docker env
  const clientUrl = process.env.CLIENT_URL;
  if (clientUrl) {
    try {
      origins.push(new URL(clientUrl).origin);
    } catch {
      origins.push(clientUrl);
    }
  }

  // Fallback: other common env vars
  const rawOrigins =
    process.env.CORS_ALLOWED_ORIGINS ??
    process.env.CLIENT_ORIGIN ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "";

  for (const entry of rawOrigins.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      const origin = new URL(trimmed).origin;
      if (!origins.includes(origin)) {
        origins.push(origin);
      }
    } catch {
      if (!origins.includes(trimmed)) {
        origins.push(trimmed);
      }
    }
  }

  // In development, also allow localhost variations
  if ((process.env.NODE_ENV ?? "development") !== "production") {
    const devOrigins = [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:3001",
    ];
    for (const origin of devOrigins) {
      if (!origins.includes(origin)) {
        origins.push(origin);
      }
    }
  }

  // Fallback to server host if no origins configured
  if (origins.length === 0) {
    const host = getServerHost();
    const protocol = process.env.NODE_ENV === "production" ? "https" : "http";
    origins.push(`${protocol}://${host}`);
  }

  return origins;
};

export const storeChallenge = (userId: string, challenge: string): void => {
  challengeCache.set(userId, {
    challenge,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  });
};

export const getStoredChallenge = (userId: string): string | null => {
  const entry = challengeCache.get(userId);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt < Date.now()) {
    challengeCache.delete(userId);
    return null;
  }
  // Delete after retrieval (one-time use)
  challengeCache.delete(userId);
  return entry.challenge;
};

// For registration (new user or adding passkey)
export const generatePasskeyRegistrationOptions = async (
  userId: string,
  username: string,
  existingCredentialIds: string[] = []
): Promise<PublicKeyCredentialCreationOptionsJSON> => {
  const options = await generateRegistrationOptions({
    rpName: getRpName(),
    rpID: getRpId(),
    userID: new TextEncoder().encode(userId),
    userName: username,
    userDisplayName: username,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
      authenticatorAttachment: "platform",
    },
    excludeCredentials: existingCredentialIds.map((id) => ({
      id,
      transports: ["internal", "hybrid"] as AuthenticatorTransportFuture[],
    })),
  });

  storeChallenge(userId, options.challenge);
  return options;
};

export const verifyPasskeyRegistration = async (
  userId: string,
  response: RegistrationResponseJSON
): Promise<VerifiedRegistrationResponse> => {
  const expectedChallenge = getStoredChallenge(userId);
  if (!expectedChallenge) {
    throw new Error("Challenge not found or expired");
  }

  return verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: getExpectedOrigins(),
    expectedRPID: getRpId(),
    requireUserVerification: false,
  });
};

// For login (discoverable credentials or specific user)
export const generatePasskeyLoginOptions = async (
  userId?: string,
  allowedCredentials?: Array<{ id: string; transports: string[] }>
): Promise<PublicKeyCredentialRequestOptionsJSON> => {
  const options = await generateAuthenticationOptions({
    rpID: getRpId(),
    userVerification: "preferred",
    allowCredentials: allowedCredentials?.map((cred) => ({
      id: cred.id,
      transports: cred.transports as AuthenticatorTransportFuture[],
    })) ?? [],
  });

  // Store challenge with a temporary key if no userId yet
  const challengeKey = userId ?? `login:${options.challenge}`;
  storeChallenge(challengeKey, options.challenge);
  return options;
};

// For login verification
export const verifyPasskeyLogin = async (
  challengeKey: string,
  response: AuthenticationResponseJSON,
  credentialPublicKey: Uint8Array,
  credentialCurrentCounter: number
): Promise<VerifiedAuthenticationResponse> => {
  const expectedChallenge = getStoredChallenge(challengeKey);
  if (!expectedChallenge) {
    throw new Error("Challenge not found or expired");
  }

  return verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: getExpectedOrigins(),
    expectedRPID: getRpId(),
    requireUserVerification: false,
    credential: {
      id: response.id,
      publicKey: new Uint8Array(credentialPublicKey),
      counter: credentialCurrentCounter,
    },
  });
};

// For passkey removal (assertion with different credential)
export const generatePasskeyRemovalOptions = async (
  userId: string,
  allowedCredentialIds: string[]
): Promise<PublicKeyCredentialRequestOptionsJSON> => {
  const options = await generateAuthenticationOptions({
    rpID: getRpId(),
    userVerification: "preferred",
    allowCredentials: allowedCredentialIds.map((id) => ({
      id,
      transports: ["internal", "hybrid"] as AuthenticatorTransportFuture[],
    })),
  });

  storeChallenge(userId, options.challenge);
  return options;
};

export const verifyPasskeyRemoval = async (
  userId: string,
  response: AuthenticationResponseJSON,
  credentialPublicKey: Uint8Array,
  credentialCurrentCounter: number
): Promise<VerifiedAuthenticationResponse> => {
  const expectedChallenge = getStoredChallenge(userId);
  if (!expectedChallenge) {
    throw new Error("Challenge not found or expired");
  }

  return verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: getExpectedOrigins(),
    expectedRPID: getRpId(),
    requireUserVerification: false,
    credential: {
      id: response.id,
      publicKey: new Uint8Array(credentialPublicKey),
      counter: credentialCurrentCounter,
    },
  });
};
