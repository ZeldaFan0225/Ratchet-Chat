import crypto from "crypto";
import dns from "dns/promises";
import fs from "fs";
import http from "http";
import https from "https";
import { isIP } from "net";
import path from "path";

import { getInstanceHost, isValidHost } from "./handles";

type FederationTlsConfig = {
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
};

type FederationRequestResult = {
  ok: boolean;
  status: number;
  json?: unknown;
  error?: string;
};

type FederationKeyPair = {
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  publicKeyBase64: string;
  keyId: string;
  createdAt: string;
};

export type FederationKeyEntry = {
  host: string;
  publicKey: string;
  key: crypto.KeyObject;
  expiresAt: number;
};

export type FederationDiscoveryKey = {
  kid: string;
  public_key: string;
  status: "active" | "next";
  created_at?: string;
  expires_at?: string | null;
};

export type FederationDiscoveryDocument = {
  host: string;
  version: number;
  inbox_url: string;
  directory_url: string;
  keys: FederationDiscoveryKey[];
  signature: string;
  signature_kid: string;
  generated_at: string;
};

let cachedTlsConfig: FederationTlsConfig | null | undefined;
let cachedFederationKeys: FederationKeyPair | null = null;
const federationKeyCache = new Map<string, FederationKeyEntry>();
const FEDERATION_CERT_PATH =
  process.env.SERVER_CERT_PATH ?? path.join(process.cwd(), ".cert");
const FEDERATION_KEY_TTL_MS = Number(
  process.env.FEDERATION_KEY_TTL_MS ?? 6 * 60 * 60 * 1000
);
const FEDERATION_DISCOVERY_TTL_MS = Number(
  process.env.FEDERATION_DISCOVERY_TTL_MS ?? 10 * 60 * 1000
);
const FEDERATION_ALLOWED_HOSTS = new Set(
  (process.env.FEDERATION_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
);
const FEDERATION_ALLOW_PRIVATE_IPS =
  process.env.FEDERATION_ALLOW_PRIVATE_IPS === "true";
const FEDERATION_TRUST_MODE = (
  process.env.FEDERATION_TRUST_MODE ??
  ((process.env.NODE_ENV ?? "development") === "production" ? "tofu" : "tofu")
).toLowerCase();

type FederationTrustEntry = {
  host: string;
  kid: string;
  publicKey: string;
  pinnedAt: number;
  verifiedAt: number;
};

type FederationDiscoveryCacheEntry = {
  doc: FederationDiscoveryDocument;
  expiresAt: number;
};

const federationTrustStore = new Map<string, FederationTrustEntry>();
const federationDiscoveryCache = new Map<string, FederationDiscoveryCacheEntry>();

const loadFederationTlsConfig = (): FederationTlsConfig | null => {
  const caPath = process.env.FEDERATION_TLS_CA_PATH;
  const certPath = process.env.FEDERATION_TLS_CERT_PATH;
  const keyPath = process.env.FEDERATION_TLS_KEY_PATH;
  if (!caPath || !certPath || !keyPath) {
    return null;
  }

  return {
    ca: fs.readFileSync(caPath),
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };
};

export const getFederationTlsConfig = (): FederationTlsConfig | null => {
  if (cachedTlsConfig === undefined) {
    cachedTlsConfig = loadFederationTlsConfig();
  }
  return cachedTlsConfig;
};

const parseEnvFile = (contents: string): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const splitIndex = trimmed.indexOf("=");
    if (splitIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, splitIndex).trim();
    let value = trimmed.slice(splitIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
};

const loadKeysFromCertFile = (): {
  privateKeyBase64?: string;
  publicKeyBase64?: string;
  createdAt?: string;
} | null => {
  if (!fs.existsSync(FEDERATION_CERT_PATH)) {
    return null;
  }
  try {
    try {
      fs.chmodSync(FEDERATION_CERT_PATH, 0o600);
    } catch {
      // Best effort only.
    }
    const contents = fs.readFileSync(FEDERATION_CERT_PATH, "utf8");
    const parsed = parseEnvFile(contents);
    return {
      privateKeyBase64: parsed.SERVER_PRIVATE_KEY,
      publicKeyBase64: parsed.SERVER_PUBLIC_KEY,
      createdAt: parsed.SERVER_KEY_CREATED_AT,
    };
  } catch {
    return null;
  }
};

const writeKeysToCertFile = (
  privateKeyBase64: string,
  publicKeyBase64: string,
  createdAt: string
) => {
  try {
    const output = [
      "SERVER_PRIVATE_KEY=" + privateKeyBase64,
      "SERVER_PUBLIC_KEY=" + publicKeyBase64,
      "SERVER_KEY_CREATED_AT=" + createdAt,
      "",
    ].join("\n");
    fs.writeFileSync(FEDERATION_CERT_PATH, output, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      fs.chmodSync(FEDERATION_CERT_PATH, 0o600);
    } catch {
      // Best effort only.
    }
  } catch {
    // Best effort only; fall back to in-memory keys if this fails.
  }
};

const createFederationKeyPair = (): FederationKeyPair => {
  const certFileKeys = loadKeysFromCertFile();
  const privateKeyBase64 =
    certFileKeys?.privateKeyBase64 ?? process.env.SERVER_PRIVATE_KEY;
  const publicKeyBase64 =
    certFileKeys?.publicKeyBase64 ?? process.env.SERVER_PUBLIC_KEY;
  const createdAt = certFileKeys?.createdAt ?? process.env.SERVER_KEY_CREATED_AT;

  if (privateKeyBase64 && publicKeyBase64) {
    const privateKey = crypto.createPrivateKey({
      key: Buffer.from(privateKeyBase64, "base64"),
      format: "der",
      type: "pkcs8",
    });
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    });
    const createdAtValue = createdAt ?? new Date().toISOString();
    if (
      !certFileKeys?.privateKeyBase64 ||
      !certFileKeys?.publicKeyBase64 ||
      !certFileKeys?.createdAt
    ) {
      writeKeysToCertFile(privateKeyBase64, publicKeyBase64, createdAtValue);
    }
    const keyId = computeKeyId(publicKeyBase64);
    return {
      privateKey,
      publicKey,
      publicKeyBase64,
      keyId,
      createdAt: createdAtValue,
    };
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const publicKeyBase64Generated = Buffer.from(publicKeyDer).toString("base64");
  const createdAtValue = new Date().toISOString();
  writeKeysToCertFile(
    privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    publicKeyBase64Generated,
    createdAtValue
  );
  const keyId = computeKeyId(publicKeyBase64Generated);
  return {
    privateKey,
    publicKey,
    publicKeyBase64: publicKeyBase64Generated,
    keyId,
    createdAt: createdAtValue,
  };
};

const getFederationKeyPair = (): FederationKeyPair => {
  if (!cachedFederationKeys) {
    cachedFederationKeys = createFederationKeyPair();
  }
  return cachedFederationKeys;
};

const normalizeHost = (host: string) => host.trim().toLowerCase();

const hostIsLocal = (host: string) => normalizeHost(host).includes("localhost");

const hostIsIp = (host: string) => {
  const hostname = normalizeHost(host).split(":")[0];
  return isIP(hostname) !== 0;
};

const isPrivateIpv4 = (ip: string): boolean => {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return true;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 0) return true;
  if (a >= 224) return true;
  return false;
};

const isPrivateIpv6 = (ip: string): boolean => {
  const value = ip.toLowerCase();
  if (value === "::" || value === "::1") {
    return true;
  }
  if (value.startsWith("fc") || value.startsWith("fd")) {
    return true;
  }
  if (
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb")
  ) {
    return true;
  }
  if (value.startsWith("ff")) {
    return true;
  }
  if (value.startsWith("::ffff:")) {
    const ipv4 = value.slice("::ffff:".length);
    return isPrivateIpv4(ipv4);
  }
  return false;
};

const isBlockedHostname = (hostname: string): boolean => {
  const lowered = hostname.toLowerCase();
  if (lowered === "localhost") {
    return true;
  }
  return (
    lowered.endsWith(".localhost") ||
    lowered.endsWith(".local") ||
    lowered.endsWith(".internal") ||
    lowered.endsWith(".lan")
  );
};

export const isFederationHostAllowed = async (
  host: string
): Promise<boolean> => {
  const normalized = normalizeHost(host);
  const hostname = normalized.split(":")[0];
  if (!hostname) {
    return false;
  }
  if (
    FEDERATION_ALLOWED_HOSTS.size > 0 &&
    !FEDERATION_ALLOWED_HOSTS.has(normalized) &&
    !FEDERATION_ALLOWED_HOSTS.has(hostname)
  ) {
    return false;
  }

  const env = process.env.NODE_ENV ?? "development";
  const allowPrivate =
    env !== "production" || FEDERATION_ALLOW_PRIVATE_IPS;

  if (isBlockedHostname(hostname)) {
    return allowPrivate;
  }

  if (isIP(hostname) !== 0) {
    if (!allowPrivate && isPrivateIpv4(hostname)) {
      return false;
    }
    return true;
  }

  try {
    const addresses = await dns.lookup(hostname, { all: true });
    if (addresses.length === 0) {
      return false;
    }
    for (const address of addresses) {
      if (!validateIp(address.address, allowPrivate)) {
        return false;
      }
    }
  } catch {
    return false;
  }

  return true;
};

const validateIp = (ip: string, allowPrivate: boolean) => {
  if (isIP(ip) === 0) {
    return false;
  }
  if (allowPrivate) {
    return true;
  }
  if (isPrivateIpv4(ip)) {
    return false;
  }
  if (isPrivateIpv6(ip)) {
    return false;
  }
  return true;
};

export const resolveFederationProtocol = (
  targetHost: string,
  mode: "outgoing" | "callback" = "outgoing"
): "http" | "https" => {
  const env = process.env.NODE_ENV ?? "development";
  const forceHttps = env === "production";
  if (!forceHttps && (hostIsLocal(targetHost) || hostIsIp(targetHost))) {
    return "http";
  }
  return "https";
};

export const getServerHost = (): string => {
  const host = process.env.SERVER_HOST ?? getInstanceHost();
  if (!host || !isValidHost(host)) {
    throw new Error("SERVER_HOST is not set or invalid");
  }
  return host;
};

export const getFederationIdentity = (): { host: string; publicKey: string } => {
  const keyPair = getFederationKeyPair();
  return {
    host: getServerHost(),
    publicKey: keyPair.publicKeyBase64,
  };
};

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  const serialized = entries
    .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`)
    .join(",");
  return `{${serialized}}`;
};

const computeKeyId = (publicKeyBase64: string) =>
  crypto
    .createHash("sha256")
    .update(Buffer.from(publicKeyBase64, "base64"))
    .digest("base64url");

export const getFederationDiscoveryDocument = (): FederationDiscoveryDocument => {
  const host = getServerHost();
  const keyPair = getFederationKeyPair();
  const generatedAt = new Date().toISOString();
  const doc = {
    host,
    version: 1,
    inbox_url: "/api/federation/incoming",
    directory_url: "/directory",
    keys: [
      {
        kid: keyPair.keyId,
        public_key: keyPair.publicKeyBase64,
        status: "active" as const,
        created_at: keyPair.createdAt,
        expires_at: null,
      },
    ],
    generated_at: generatedAt,
  };
  const signature = signFederationPayload(stableStringify(doc));
  return {
    ...doc,
    signature,
    signature_kid: keyPair.keyId,
  };
};

export const signFederationPayload = (payload: string): string => {
  const { privateKey } = getFederationKeyPair();
  const signature = crypto.sign(null, Buffer.from(payload, "utf8"), privateKey);
  return signature.toString("base64");
};

export const verifyFederationPayload = (
  payload: string,
  signature: string,
  publicKey: crypto.KeyObject
): boolean => {
  try {
    return crypto.verify(
      null,
      Buffer.from(payload, "utf8"),
      publicKey,
      Buffer.from(signature, "base64")
    );
  } catch {
    return false;
  }
};

export const federationRequestJson = async (
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  }
): Promise<FederationRequestResult> => {
  const parsed = new URL(url);
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const payload =
    options.body === undefined || options.body === null
      ? null
      : typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);
  if (payload) {
    if (!headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    headers["Content-Length"] = Buffer.byteLength(payload).toString();
  }

  // Security: Resolve IP and validate to prevent DNS rebinding / SSRF.
  const hostname = parsed.hostname;
  let ip: string;
  try {
    if (isIP(hostname)) {
      ip = hostname;
    } else {
      const addresses = await dns.lookup(hostname);
      ip = addresses.address;
    }
  } catch {
    return { ok: false, status: 502, error: "DNS lookup failed" };
  }

  const env = process.env.NODE_ENV ?? "development";
  const allowPrivate =
    env !== "production" || FEDERATION_ALLOW_PRIVATE_IPS;

  if (isBlockedHostname(hostname)) {
    if (!allowPrivate) return { ok: false, status: 403, error: "Host not allowed" };
  }
  
  if (!validateIp(ip, allowPrivate)) {
    return { ok: false, status: 403, error: "IP not allowed" };
  }

    // Force Host header to original hostname
    headers["Host"] = hostname;
  
    const requestOptions: https.RequestOptions = {
      method,
      hostname: ip, // Use resolved IP
      port: parsed.port
        ? Number(parsed.port)
        : parsed.protocol === "https:"
          ? 443
          : 80,
      path: `${parsed.pathname}${parsed.search}`,
      headers,
      // For HTTPS, we must set servername for SNI since we are connecting to an IP
      servername: hostname,
    };  const requestClient = parsed.protocol === "https:" ? https : http;

  return await new Promise<FederationRequestResult>((resolve, reject) => {
    const req = requestClient.request(requestOptions, (res) => {
      const status = res.statusCode ?? 500;
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let json: unknown = undefined;
        if (raw) {
          try {
            json = JSON.parse(raw);
          } catch {
            json = undefined;
          }
        }
        resolve({
          ok: status >= 200 && status < 300,
          status,
          json,
        });
      });
    });

    req.on("error", (error) => {
      // Don't reject, resolve with error to handle gracefully
      resolve({ ok: false, status: 502, error: error.message });
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
};

const createPublicKeyFromBase64 = (publicKey: string) =>
  crypto.createPublicKey({
    key: Buffer.from(publicKey, "base64"),
    format: "der",
    type: "spki",
  });

const selectActiveKey = (
  keys: FederationDiscoveryKey[]
): FederationDiscoveryKey | null => {
  const active = keys.find((key) => key.status === "active");
  return active ?? keys[0] ?? null;
};

const isDiscoveryHostValid = (
  normalizedHost: string,
  doc: FederationDiscoveryDocument
) => {
  if (normalizeHost(doc.host) !== normalizedHost) {
    return false;
  }
  const urls = [doc.inbox_url, doc.directory_url];
  for (const url of urls) {
    if (!url) {
      return false;
    }
    if (!url.startsWith("http")) {
      continue;
    }
    try {
      const parsed = new URL(url);
      if (normalizeHost(parsed.host) !== normalizedHost) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
};

const verifyDiscoverySignature = (
  doc: FederationDiscoveryDocument,
  publicKeyBase64: string
) => {
  if (!doc.signature) {
    return false;
  }
  const unsigned = {
    host: doc.host,
    version: doc.version,
    inbox_url: doc.inbox_url,
    directory_url: doc.directory_url,
    keys: doc.keys,
    generated_at: doc.generated_at,
  };
  return verifyFederationPayload(
    stableStringify(unsigned),
    doc.signature,
    createPublicKeyFromBase64(publicKeyBase64)
  );
};

const recordTrust = (
  normalizedHost: string,
  key: FederationDiscoveryKey,
  verified: boolean
) => {
  const now = Date.now();
  federationTrustStore.set(normalizedHost, {
    host: normalizedHost,
    kid: key.kid,
    publicKey: key.public_key,
    pinnedAt: now,
    verifiedAt: verified ? now : 0,
  });
};

const resolveTrustedKeyFromDiscovery = (
  normalizedHost: string,
  doc: FederationDiscoveryDocument
): FederationDiscoveryKey | null => {
  if (!doc.keys || doc.keys.length === 0) {
    return null;
  }
  if (!doc.keys.some((key) => key.kid === doc.signature_kid)) {
    return null;
  }
  const trust = federationTrustStore.get(normalizedHost);
  const activeKey = selectActiveKey(doc.keys);
  if (!activeKey) {
    return null;
  }
  if (!trust) {
    if (FEDERATION_TRUST_MODE === "strict") {
      return null;
    }
    recordTrust(normalizedHost, activeKey, false);
    return activeKey;
  }
  const verified = verifyDiscoverySignature(doc, trust.publicKey);
  if (!verified) {
    return null;
  }
  if (
    trust.kid !== activeKey.kid ||
    trust.publicKey !== activeKey.public_key
  ) {
    recordTrust(normalizedHost, activeKey, true);
  } else {
    trust.verifiedAt = Date.now();
  }
  return activeKey;
};

const getDiscoveryCacheEntry = (host: string) => {
  const cached = federationDiscoveryCache.get(host);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }
  if (cached) {
    federationDiscoveryCache.delete(host);
  }
  return null;
};

export const fetchFederationDiscovery = async (
  senderHost: string
): Promise<FederationDiscoveryDocument | null> => {
  const normalizedHost = normalizeHost(senderHost);
  if (!isValidHost(normalizedHost)) {
    return null;
  }
  const cached = getDiscoveryCacheEntry(normalizedHost);
  if (cached) {
    return cached.doc;
  }
  if (!(await isFederationHostAllowed(normalizedHost))) {
    return null;
  }
  const protocol = resolveFederationProtocol(senderHost, "callback");
  const remoteUrl = `${protocol}://${senderHost}/.well-known/ratchet-chat/federation.json`;
  let response: FederationRequestResult;
  try {
    response = await federationRequestJson(remoteUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch {
    return null;
  }
  if (!response.ok || !response.json || typeof response.json !== "object") {
    return null;
  }
  const doc = response.json as FederationDiscoveryDocument;
  if (
    !doc.host ||
    !doc.inbox_url ||
    !doc.directory_url ||
    !Array.isArray(doc.keys) ||
    !doc.signature ||
    !doc.signature_kid
  ) {
    return null;
  }
  if (!isDiscoveryHostValid(normalizedHost, doc)) {
    return null;
  }
  const trustedKey = resolveTrustedKeyFromDiscovery(normalizedHost, doc);
  if (!trustedKey) {
    return null;
  }
  federationDiscoveryCache.set(normalizedHost, {
    doc,
    expiresAt: Date.now() + FEDERATION_DISCOVERY_TTL_MS,
  });
  return doc;
};

export const resolveFederationEndpoint = async (
  targetHost: string,
  endpoint: "inbox" | "directory"
): Promise<string | null> => {
  const doc = await fetchFederationDiscovery(targetHost);
  const protocol = resolveFederationProtocol(targetHost);
  const hostPrefix = `${protocol}://${targetHost}`;
  if (!doc) {
    return null;
  }
  const raw =
    endpoint === "inbox"
      ? doc.inbox_url
      : doc.directory_url;
  if (raw.startsWith("http")) {
    return raw;
  }
  const normalized = raw.startsWith("/") ? raw : `/${raw}`;
  return `${hostPrefix}${normalized}`;
};

export const fetchFederationKey = async (
  senderHost: string
): Promise<FederationKeyEntry | null> => {
  const normalizedHost = normalizeHost(senderHost);
  if (!isValidHost(normalizedHost)) {
    return null;
  }
  const cached = federationKeyCache.get(normalizedHost);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }
  if (cached) {
    federationKeyCache.delete(normalizedHost);
  }
  if (!(await isFederationHostAllowed(normalizedHost))) {
    return null;
  }

  const discoveryDoc = await fetchFederationDiscovery(senderHost);
  if (discoveryDoc) {
    const activeKey = selectActiveKey(discoveryDoc.keys);
    if (activeKey?.public_key) {
      const entry: FederationKeyEntry = {
        host: normalizedHost,
        publicKey: activeKey.public_key,
        key: createPublicKeyFromBase64(activeKey.public_key),
        expiresAt: Date.now() + FEDERATION_KEY_TTL_MS,
      };
      federationKeyCache.set(normalizedHost, entry);
      return entry;
    }
  }

  const protocol = resolveFederationProtocol(senderHost, "callback");
  const remoteUrl = `${protocol}://${senderHost}/api/federation/key`;
  let response: FederationRequestResult;
  try {
    response = await federationRequestJson(remoteUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  const data = response.json as { publicKey?: string; host?: string } | undefined;
  if (!data?.publicKey || typeof data.publicKey !== "string") {
    return null;
  }
  const kid = computeKeyId(data.publicKey);
  if (!federationTrustStore.has(normalizedHost)) {
    if (FEDERATION_TRUST_MODE === "strict") {
      return null;
    }
    recordTrust(
      normalizedHost,
      { kid, public_key: data.publicKey, status: "active" },
      false
    );
  } else {
    const trust = federationTrustStore.get(normalizedHost);
    if (trust && trust.publicKey !== data.publicKey) {
      return null;
    }
  }
  const entry: FederationKeyEntry = {
    host: normalizedHost,
    publicKey: data.publicKey,
    key: createPublicKeyFromBase64(data.publicKey),
    expiresAt: Date.now() + FEDERATION_KEY_TTL_MS,
  };
  federationKeyCache.set(normalizedHost, entry);
  return entry;
};
