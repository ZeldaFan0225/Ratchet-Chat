import { webcrypto } from "crypto";
import fs from "fs";
import path from "path";
import {
  ExpectedAuthResult,
  KE1,
  KE3,
  OpaqueID,
  OpaqueServer,
  RegistrationRecord,
  RegistrationRequest,
  getOpaqueConfig,
  type AKEExportKeyPair,
} from "@cloudflare/opaque-ts";

export type ServerRegistrationState = null;
export type ServerLoginState = ExpectedAuthResult;

const globalCrypto = globalThis as typeof globalThis & { crypto?: any };
if (!globalCrypto.crypto) {
  globalCrypto.crypto = webcrypto as any;
}

const config = getOpaqueConfig(OpaqueID.OPAQUE_P256);

let serverInstance: OpaqueServer | null = null;
let cachedOpaqueKeys: { oprfSeed: number[]; akeKeypair: AKEExportKeyPair } | null =
  null;
const OPAQUE_FILE_PATH =
  process.env.OPAQUE_FILE_PATH ?? path.join(process.cwd(), ".opaque");

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

const loadOpaqueKeysFromFile = (): {
  oprfSeedBase64?: string;
  akePrivateKeyBase64?: string;
  akePublicKeyBase64?: string;
} | null => {
  if (!fs.existsSync(OPAQUE_FILE_PATH)) {
    return null;
  }
  try {
    try {
      fs.chmodSync(OPAQUE_FILE_PATH, 0o600);
    } catch {
      // Best effort only.
    }
    const contents = fs.readFileSync(OPAQUE_FILE_PATH, "utf8");
    const parsed = parseEnvFile(contents);
    return {
      oprfSeedBase64: parsed.OPAQUE_OPRF_SEED,
      akePrivateKeyBase64: parsed.OPAQUE_AKE_PRIVATE_KEY,
      akePublicKeyBase64: parsed.OPAQUE_AKE_PUBLIC_KEY,
    };
  } catch {
    return null;
  }
};

const writeOpaqueKeysToFile = (
  oprfSeedBase64: string,
  akePrivateKeyBase64: string,
  akePublicKeyBase64: string
) => {
  try {
    const output = [
      "OPAQUE_OPRF_SEED=" + oprfSeedBase64,
      "OPAQUE_AKE_PRIVATE_KEY=" + akePrivateKeyBase64,
      "OPAQUE_AKE_PUBLIC_KEY=" + akePublicKeyBase64,
      "",
    ].join("\n");
    fs.writeFileSync(OPAQUE_FILE_PATH, output, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      fs.chmodSync(OPAQUE_FILE_PATH, 0o600);
    } catch {
      // Best effort only.
    }
  } catch {
    // Best effort only; fall back to in-memory keys if this fails.
  }
};

const toBase64 = (values: number[]): string => Buffer.from(values).toString("base64");
const fromBase64 = (value: string): number[] =>
  Array.from(Buffer.from(value, "base64"));

const getOpaqueKeys = async (): Promise<{
  oprfSeed: number[];
  akeKeypair: AKEExportKeyPair;
}> => {
  if (cachedOpaqueKeys) {
    return cachedOpaqueKeys;
  }

  const fileKeys = loadOpaqueKeysFromFile();
  const oprfSeedBase64 = fileKeys?.oprfSeedBase64 ?? process.env.OPAQUE_OPRF_SEED;
  const akePrivateKeyBase64 =
    fileKeys?.akePrivateKeyBase64 ?? process.env.OPAQUE_AKE_PRIVATE_KEY;
  const akePublicKeyBase64 =
    fileKeys?.akePublicKeyBase64 ?? process.env.OPAQUE_AKE_PUBLIC_KEY;

  if (oprfSeedBase64 && akePrivateKeyBase64 && akePublicKeyBase64) {
    const oprfSeed = fromBase64(oprfSeedBase64);
    const akeKeypair = {
      private_key: fromBase64(akePrivateKeyBase64),
      public_key: fromBase64(akePublicKeyBase64),
    };
    if (
      !fileKeys?.oprfSeedBase64 ||
      !fileKeys?.akePrivateKeyBase64 ||
      !fileKeys?.akePublicKeyBase64
    ) {
      writeOpaqueKeysToFile(
        oprfSeedBase64,
        akePrivateKeyBase64,
        akePublicKeyBase64
      );
    }
    cachedOpaqueKeys = { oprfSeed, akeKeypair };
    return cachedOpaqueKeys;
  }

  const oprfSeed = config.prng.random(config.hash.Nh);
  const akeKeypair = await config.ake.generateAuthKeyPair();
  writeOpaqueKeysToFile(
    toBase64(oprfSeed),
    toBase64(akeKeypair.private_key),
    toBase64(akeKeypair.public_key)
  );
  cachedOpaqueKeys = { oprfSeed, akeKeypair };
  return cachedOpaqueKeys;
};

const getServer = async () => {
  if (serverInstance) {
    return serverInstance;
  }
  const { oprfSeed, akeKeypair } = await getOpaqueKeys();
  serverInstance = new OpaqueServer(config, oprfSeed, akeKeypair);
  return serverInstance;
};

const toBytes = (bytes: number[]): Uint8Array => Uint8Array.from(bytes);
const toNumbers = (bytes: Uint8Array): number[] => Array.from(bytes);

export const registerResponse = async (
  username: string,
  clientRequest: Uint8Array
): Promise<{ response: Uint8Array; state: ServerRegistrationState }> => {
  const server = await getServer();
  const request = RegistrationRequest.deserialize(config, toNumbers(clientRequest));
  const response = await server.registerInit(request, username);
  if (response instanceof Error) {
    throw response;
  }
  return { response: toBytes(response.serialize()), state: null };
};

export const registerFinish = (
  _state: ServerRegistrationState,
  clientFinish: Uint8Array
): Uint8Array => {
  const record = RegistrationRecord.deserialize(config, toNumbers(clientFinish));
  return toBytes(record.serialize());
};

export const loginResponse = async (
  username: string,
  passwordFile: Uint8Array,
  clientRequest: Uint8Array
): Promise<{ response: Uint8Array; state: ServerLoginState }> => {
  const server = await getServer();
  const ke1 = KE1.deserialize(config, toNumbers(clientRequest));
  const record = RegistrationRecord.deserialize(config, toNumbers(passwordFile));
  const result = await server.authInit(ke1, record, username);
  if (result instanceof Error) {
    throw result;
  }
  return { response: toBytes(result.ke2.serialize()), state: result.expected };
};

export const loginFinish = async (
  state: ServerLoginState,
  clientFinish: Uint8Array
): Promise<Uint8Array> => {
  const server = await getServer();
  const ke3 = KE3.deserialize(config, toNumbers(clientFinish));
  const response = server.authFinish(ke3, state);
  if (response instanceof Error) {
    throw response;
  }
  return toBytes(response.session_key);
};
