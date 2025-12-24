const HOST_PATTERN = /^[a-zA-Z0-9.-]+(?::\d+)?$/;

export type HandleParts = {
  username: string;
  host: string;
  handle: string;
};

export function getInstanceHost(): string | null {
  const explicit =
    process.env.NEXT_PUBLIC_API_HOST ?? process.env.NEXT_PUBLIC_INSTANCE_HOST;
  if (explicit && HOST_PATTERN.test(explicit)) {
    return explicit;
  }
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (apiUrl) {
    try {
      const parsed = new URL(apiUrl);
      if (parsed.host && HOST_PATTERN.test(parsed.host)) {
        return parsed.host;
      }
    } catch {
      // Ignore invalid URL.
    }
  }
  if (typeof window !== "undefined" && HOST_PATTERN.test(window.location.host)) {
    return window.location.host;
  }
  return null;
}

export function normalizeHandle(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.includes("@")) {
    return trimmed;
  }
  const host = getInstanceHost();
  return host ? `${trimmed}@${host}` : trimmed;
}

export function splitHandle(input: string): HandleParts | null {
  const handle = normalizeHandle(input);
  const atIndex = handle.lastIndexOf("@");
  if (atIndex <= 0) {
    return null;
  }
  const username = handle.slice(0, atIndex);
  const host = handle.slice(atIndex + 1);
  if (!username || !host || !HOST_PATTERN.test(host)) {
    return null;
  }
  return { username, host, handle: `${username}@${host}` };
}
