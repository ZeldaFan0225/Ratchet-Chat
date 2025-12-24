import fs from "fs";
import path from "path";
import winston from "winston";

const LOG_DIR = process.env.LOG_DIR ?? path.join(process.cwd(), "logs");
const SERVER_LOG_PATH =
  process.env.SERVER_LOG_PATH ?? path.join(LOG_DIR, "server.log");
const CLIENT_LOG_PATH =
  process.env.CLIENT_LOG_PATH ?? path.join(LOG_DIR, "client.log");
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
const MAX_STRING_LENGTH = Number(process.env.LOG_MAX_STRING_LENGTH ?? 20000);

const SENSITIVE_KEYS = new Set([
  "password",
  "auth_hash",
  "auth_salt",
  "kdf_salt",
  "encrypted_identity_key",
  "encrypted_transport_key",
  "encrypted_identity_iv",
  "encrypted_transport_iv",
  "private_key",
  "server_private_key",
  "token",
  "authorization",
  "cookie",
  "masterkey",
  "identityprivatekey",
  "transportprivatekey",
]);

const ensureLogDir = () => {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
};

const buildLogger = (filename: string) => {
  ensureLogDir();
  return winston.createLogger({
    level: LOG_LEVEL,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    transports: [new winston.transports.File({ filename })],
  });
};

export const serverLogger = buildLogger(SERVER_LOG_PATH);
export const clientLogger = buildLogger(CLIENT_LOG_PATH);

export const sanitizeLogPayload = (value: unknown): unknown => {
  const seen = new WeakSet<object>();

  const sanitize = (input: unknown, key?: string): unknown => {
    const loweredKey = key?.toLowerCase();
    if (loweredKey && SENSITIVE_KEYS.has(loweredKey)) {
      return "[redacted]";
    }
    if (typeof input === "string") {
      if (input.length > MAX_STRING_LENGTH) {
        return `${input.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
      }
      return input;
    }
    if (Buffer.isBuffer(input)) {
      return input.toString("base64");
    }
    if (!input || typeof input !== "object") {
      return input;
    }
    if (seen.has(input)) {
      return "[circular]";
    }
    seen.add(input);

    if (Array.isArray(input)) {
      return input.map((item) => sanitize(item));
    }

    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([childKey, val]) => [
        childKey,
        sanitize(val, childKey),
      ])
    );
  };

  return sanitize(value);
};
