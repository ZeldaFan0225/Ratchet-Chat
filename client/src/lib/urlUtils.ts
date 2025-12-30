// URL pattern that matches http/https URLs
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;

// File extensions that are likely media files (skip embed for these)
const MEDIA_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".bmp",
  ".mp4",
  ".webm",
  ".mov",
  ".avi",
  ".mkv",
  ".mp3",
  ".wav",
  ".ogg",
  ".pdf",
];

/**
 * Extract the first URL from a text string
 */
export function extractUrl(text: string): string | null {
  const matches = text.match(URL_REGEX);
  return matches ? matches[0] : null;
}

/**
 * Extract all URLs from a text string
 */
export function extractAllUrls(text: string): string[] {
  return text.match(URL_REGEX) || [];
}

/**
 * Check if a URL should be embedded (not a direct media file)
 */
export function isEmbeddable(url: string): boolean {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();

    // Skip direct media file URLs
    for (const ext of MEDIA_EXTENSIONS) {
      if (pathname.endsWith(ext)) {
        return false;
      }
    }

    // Skip data URLs
    if (parsed.protocol === "data:") {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
