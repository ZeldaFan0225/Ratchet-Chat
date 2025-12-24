import type { NextFunction, Request, Response } from "express";

import {
  fetchFederationKey,
  verifyFederationPayload,
} from "../lib/federationAuth";
import { getInstanceHost, parseHandle } from "../lib/handles";
import { serverLogger, sanitizeLogPayload } from "../lib/logger";

type FederationVerificationOptions = {
  requireSenderHandle?: boolean;
};

const extractHeader = (value: string | string[] | undefined): string | null => {
  if (Array.isArray(value)) {
    return value[0]?.trim() ?? null;
  }
  return value?.trim() ?? null;
};

export const verifyFederationSignature =
  (options: FederationVerificationOptions = {}) =>
  async (req: Request, res: Response, next: NextFunction) => {
    const senderHost = extractHeader(req.headers["x-ratchet-host"]);
    const signature = extractHeader(req.headers["x-ratchet-sig"]);

    if (!senderHost || !signature) {
      serverLogger.warn("federation.verify.failed", {
        reason: "missing_signature",
        path: req.path,
        headers: sanitizeLogPayload(req.headers),
      });
      return res.status(401).json({ error: "Missing federation signature" });
    }

    if (options.requireSenderHandle ?? true) {
      const senderHandle =
        typeof req.body?.sender_handle === "string"
          ? req.body.sender_handle
          : null;
      if (!senderHandle) {
        serverLogger.warn("federation.verify.failed", {
          reason: "missing_sender_handle",
          sender_host: senderHost,
          path: req.path,
        });
        return res.status(400).json({ error: "Missing sender handle" });
      }
      let parsed;
      try {
        parsed = parseHandle(senderHandle, getInstanceHost());
      } catch {
        serverLogger.warn("federation.verify.failed", {
          reason: "invalid_sender_handle",
          sender_host: senderHost,
          sender_handle: senderHandle,
          path: req.path,
        });
        return res.status(400).json({ error: "Invalid sender handle" });
      }
      if (parsed.host.toLowerCase() !== senderHost.toLowerCase()) {
        serverLogger.warn("federation.verify.failed", {
          reason: "sender_host_mismatch",
          sender_host: senderHost,
          sender_handle: senderHandle,
          path: req.path,
        });
        return res.status(403).json({ error: "Sender host mismatch" });
      }
    }

    const keyEntry = await fetchFederationKey(senderHost);
    if (!keyEntry) {
      serverLogger.warn("federation.verify.failed", {
        reason: "key_fetch_failed",
        sender_host: senderHost,
        path: req.path,
      });
      return res.status(401).json({ error: "Unauthorized" });
    }

    const payload = JSON.stringify(req.body ?? {});
    const verified = verifyFederationPayload(payload, signature, keyEntry.key);
    if (!verified) {
      serverLogger.warn("federation.verify.failed", {
        reason: "invalid_signature",
        sender_host: senderHost,
        path: req.path,
        payload: sanitizeLogPayload(req.body),
      });
      return res.status(401).json({ error: "Unauthorized" });
    }

    serverLogger.info("federation.verify.success", {
      sender_host: senderHost,
      path: req.path,
    });

    return next();
  };
