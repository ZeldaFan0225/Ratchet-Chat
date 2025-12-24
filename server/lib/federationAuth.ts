import crypto from "crypto";
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
};

export type FederationKeyEntry = {
  host: string;
  publicKey: string;
  key: crypto.KeyObject;
};

let cachedTlsConfig: FederationTlsConfig | null | undefined;
let cachedFederationKeys: FederationKeyPair | null = null;
const federationKeyCache = new Map<string, FederationKeyEntry>();
const FEDERATION_CERT_PATH =
  process.env.SERVER_CERT_PATH ?? path.join(process.cwd(), ".cert");

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
} | null => {
  if (!fs.existsSync(FEDERATION_CERT_PATH)) {
    return null;
  }
  try {
    const contents = fs.readFileSync(FEDERATION_CERT_PATH, "utf8");
    const parsed = parseEnvFile(contents);
    return {
      privateKeyBase64: parsed.SERVER_PRIVATE_KEY,
      publicKeyBase64: parsed.SERVER_PUBLIC_KEY,
    };
  } catch {
    return null;
  }
};

const writeKeysToCertFile = (
  privateKeyBase64: string,
  publicKeyBase64: string
) => {
  try {
    const output = [
      "SERVER_PRIVATE_KEY=" + privateKeyBase64,
      "SERVER_PUBLIC_KEY=" + publicKeyBase64,
      "",
    ].join("\n");
    fs.writeFileSync(FEDERATION_CERT_PATH, output, { encoding: "utf8" });
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
    if (!certFileKeys?.privateKeyBase64 || !certFileKeys?.publicKeyBase64) {
      writeKeysToCertFile(privateKeyBase64, publicKeyBase64);
    }
    return {
      privateKey,
      publicKey,
      publicKeyBase64,
    };
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const publicKeyBase64Generated = Buffer.from(publicKeyDer).toString("base64");
  writeKeysToCertFile(
    privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    publicKeyBase64Generated
  );
  return {
    privateKey,
    publicKey,
    publicKeyBase64: publicKeyBase64Generated,
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

  const requestOptions: http.RequestOptions = {
    method,
    hostname: parsed.hostname,
    port: parsed.port
      ? Number(parsed.port)
      : parsed.protocol === "https:"
        ? 443
        : 80,
    path: `${parsed.pathname}${parsed.search}`,
    headers,
  };
  const requestClient = parsed.protocol === "https:" ? https : http;

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
      reject(error);
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

export const fetchFederationKey = async (
  senderHost: string
): Promise<FederationKeyEntry | null> => {
  const normalizedHost = normalizeHost(senderHost);
  if (!isValidHost(normalizedHost)) {
    return null;
  }
  const cached = federationKeyCache.get(normalizedHost);
  if (cached) {
    return cached;
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
  const entry: FederationKeyEntry = {
    host: normalizedHost,
    publicKey: data.publicKey,
    key: createPublicKeyFromBase64(data.publicKey),
  };
  federationKeyCache.set(normalizedHost, entry);
  return entry;
};
