import type { Request, Response } from "express";
import { Router } from "express";

type EmbedData = {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
};

// Simple LRU cache for embed data
const cache = new Map<string, { data: EmbedData; timestamp: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const MAX_CACHE_SIZE = 500;

function getCached(url: string): EmbedData | null {
  const entry = cache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(url);
    return null;
  }
  return entry.data;
}

function setCache(url: string, data: EmbedData): void {
  // Evict oldest entries if cache is full
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(url, { data, timestamp: Date.now() });
}

// Block private IP ranges and localhost
function isPrivateUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();

    // Block localhost
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    ) {
      return true;
    }

    // Block private IP ranges (simple check for common patterns)
    if (
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname.match(/^172\.(1[6-9]|2[0-9]|3[01])\./) ||
      hostname.startsWith("169.254.") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal")
    ) {
      return true;
    }

    return false;
  } catch {
    return true;
  }
}

// Extract meta tag content from HTML
function extractMetaTags(html: string): Record<string, string> {
  const tags: Record<string, string> = {};

  // Match <meta property="og:xxx" content="yyy"> and <meta name="xxx" content="yyy">
  const metaRegex =
    /<meta\s+(?:[^>]*?\s+)?(?:property|name)=["']([^"']+)["']\s+(?:[^>]*?\s+)?content=["']([^"']+)["'][^>]*>/gi;
  const metaRegex2 =
    /<meta\s+(?:[^>]*?\s+)?content=["']([^"']+)["']\s+(?:[^>]*?\s+)?(?:property|name)=["']([^"']+)["'][^>]*>/gi;

  let match;
  while ((match = metaRegex.exec(html)) !== null) {
    tags[match[1].toLowerCase()] = decodeHtmlEntities(match[2]);
  }
  while ((match = metaRegex2.exec(html)) !== null) {
    tags[match[2].toLowerCase()] = decodeHtmlEntities(match[1]);
  }

  // Extract <title>
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    tags["title"] = decodeHtmlEntities(titleMatch[1].trim());
  }

  return tags;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function resolveImageUrl(imageUrl: string | undefined, baseUrl: string): string | null {
  if (!imageUrl) return null;
  try {
    // Handle protocol-relative URLs
    if (imageUrl.startsWith("//")) {
      const base = new URL(baseUrl);
      return `${base.protocol}${imageUrl}`;
    }
    // Handle relative URLs
    if (!imageUrl.startsWith("http")) {
      return new URL(imageUrl, baseUrl).href;
    }
    return imageUrl;
  } catch {
    return null;
  }
}

export const createEmbedRouter = () => {
  const router = Router();

  router.get("/", async (req: Request, res: Response) => {
    const urlParam = req.query.url;
    if (typeof urlParam !== "string" || !urlParam) {
      return res.status(400).json({ error: "Missing url parameter" });
    }

    // Validate URL
    let url: URL;
    try {
      url = new URL(urlParam);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return res.status(400).json({ error: "Invalid URL protocol" });
      }
    } catch {
      return res.status(400).json({ error: "Invalid URL" });
    }

    // Security: block private IPs
    if (isPrivateUrl(urlParam)) {
      return res.status(400).json({ error: "URL not allowed" });
    }

    // Check cache
    const cached = getCached(urlParam);
    if (cached) {
      return res.json(cached);
    }

    try {
      // Fetch with timeout and size limit
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(urlParam, {
        signal: controller.signal,
        headers: {
          "User-Agent": "RatchetChatBot/1.0 (Link Preview)",
          Accept: "text/html,application/xhtml+xml",
        },
        redirect: "follow",
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return res.status(404).json({ error: "Failed to fetch URL" });
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
        return res.status(404).json({ error: "Not an HTML page" });
      }

      // Read limited response body (512KB max)
      const reader = response.body?.getReader();
      if (!reader) {
        return res.status(500).json({ error: "Failed to read response" });
      }

      const chunks: Uint8Array[] = [];
      let totalSize = 0;
      const maxSize = 512 * 1024;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalSize += value.length;
          if (totalSize > maxSize) break;
          chunks.push(value);
        }
      }

      const html = new TextDecoder().decode(
        new Uint8Array(chunks.reduce((acc, chunk) => [...acc, ...chunk], [] as number[]))
      );

      // Parse meta tags
      const tags = extractMetaTags(html);

      const embedData: EmbedData = {
        url: urlParam,
        title: tags["og:title"] || tags["twitter:title"] || tags["title"] || null,
        description:
          tags["og:description"] || tags["twitter:description"] || tags["description"] || null,
        image: resolveImageUrl(
          tags["og:image"] || tags["twitter:image"] || tags["twitter:image:src"],
          urlParam
        ),
        siteName: tags["og:site_name"] || null,
      };

      // Cache successful results
      if (embedData.title || embedData.description) {
        setCache(urlParam, embedData);
      }

      return res.json(embedData);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return res.status(504).json({ error: "Request timeout" });
      }
      console.error("Embed fetch error:", error);
      return res.status(500).json({ error: "Failed to fetch embed data" });
    }
  });

  return router;
};
