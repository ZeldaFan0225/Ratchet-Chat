export type HandleParts = {
  username: string;
  host: string;
  handle: string;
  isLocal: boolean;
};

const HOST_PATTERN = /^[a-zA-Z0-9.-]+(?::\d+)?$/;

export const getInstanceHost = (): string => {
  const host =
    process.env.SERVER_HOST ??
    process.env.INSTANCE_HOST ??
    process.env.PUBLIC_HOSTNAME ??
    process.env.HOSTNAME;
  if (!host || !HOST_PATTERN.test(host)) {
    throw new Error("SERVER_HOST/INSTANCE_HOST is not set or invalid");
  }
  return host;
};

export const isValidHost = (host: string): boolean => HOST_PATTERN.test(host);

export const normalizeHandle = (input: string, instanceHost: string): string => {
  if (input.includes("@")) {
    return input;
  }
  return `${input}@${instanceHost}`;
};

export const parseHandle = (
  input: string,
  instanceHost: string,
): HandleParts => {
  const normalized = normalizeHandle(input, instanceHost);
  const atIndex = normalized.lastIndexOf("@");
  const username = normalized.slice(0, atIndex);
  const host = normalized.slice(atIndex + 1);
  if (!username || !host || !HOST_PATTERN.test(host)) {
    throw new Error("Invalid handle");
  }
  return {
    username,
    host,
    handle: `${username}@${host}`,
    isLocal: host === instanceHost,
  };
};

export const buildHandle = (username: string, instanceHost: string): string =>
  `${username}@${instanceHost}`;
