import type { PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import type { Server as SocketIOServer } from "socket.io";

import { authenticateToken } from "../middleware/auth";
import {
  federationRequestJson,
  getFederationIdentity,
  getServerHost,
  isFederationHostAllowed,
  resolveFederationProtocol,
  resolveFederationEndpoint,
  signFederationPayload,
} from "../lib/federationAuth";
import { verifyFederationSignature } from "../middleware/federation";
import { buildHandle, getInstanceHost, parseHandle } from "../lib/handles";
import { serverLogger, sanitizeLogPayload } from "../lib/logger";
import { createRateLimiter } from "../middleware/rateLimit";

const sendSchema = z.object({
  recipient_handle: z.string().min(1),
  encrypted_blob: z.string().min(1),
  message_id: z.string().uuid(),
  event_type: z
    .enum(["message", "edit", "delete", "reaction", "receipt", "key_rotation"])
    .optional(),
  reaction_emoji: z.string().optional(),
  sender_vault_blob: z.string().min(1).optional(),
  sender_vault_iv: z.string().min(1).optional(),
  sender_vault_signature_verified: z.boolean().optional(),
});

const incomingSchema = z.object({
  recipient_handle: z.string().min(1),
  sender_handle: z.string().min(1),
  encrypted_blob: z.string().min(1),
});

const vaultSchema = z.object({
  encrypted_blob: z.string().min(1),
  iv: z.string().min(1),
  original_sender_handle: z.string().min(1),
  sender_signature_verified: z.boolean(),
  message_id: z.string().uuid().optional(),
});

const storeFromQueueSchema = z.object({
  encrypted_blob: z.string().min(1),
  iv: z.string().min(1),
  sender_signature_verified: z.boolean(),
});

const vaultUpdateSchema = z.object({
  encrypted_blob: z.string().min(1),
  iv: z.string().min(1),
  expected_version: z.number().int().min(0).optional(),
  deleted: z.boolean().optional(),
});

export const createMessagesRouter = (
  prisma: PrismaClient,
  io: SocketIOServer
) => {
  const router = Router();
  const instanceHost = getInstanceHost();
  const serverHost = getServerHost();
  const federationIncomingPath = "/api/federation/incoming";
  const federationLimiter = createRateLimiter({
    windowMs: Number(process.env.FEDERATION_RATE_LIMIT_WINDOW_MS ?? 60000),
    max: Number(process.env.FEDERATION_RATE_LIMIT_MAX ?? 120),
    keyPrefix: "federation",
    keyGenerator: (req) => {
      const header = req.headers["x-ratchet-host"];
      if (Array.isArray(header)) {
        return header[0] ?? req.ip ?? "";
      }
      return header ?? req.ip ?? "";
    },
  });

  router.get("/api/federation/key", (req: Request, res: Response) => {
    const identity = getFederationIdentity();
    serverLogger.info("federation.key.request", {
      host: identity.host,
    });
    return res.json({
      host: identity.host,
      publicKey: identity.publicKey,
    });
  });

  const handleFederationIncoming = async (req: Request, res: Response) => {
    const parsed = incomingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const { recipient_handle, sender_handle, encrypted_blob } = parsed.data;
    serverLogger.info("federation.incoming.received", {
      sender_host: req.headers["x-ratchet-host"],
      payload: sanitizeLogPayload({
        recipient_handle,
        sender_handle,
        encrypted_blob,
      }),
    });
    let recipientParsed;
    let senderParsed;
    try {
      recipientParsed = parseHandle(recipient_handle, instanceHost);
      senderParsed = parseHandle(sender_handle, instanceHost);
    } catch {
      return res.status(400).json({ error: "Invalid handle" });
    }

    if (!recipientParsed.isLocal) {
      return res.status(400).json({ error: "Recipient not local" });
    }

    if (senderParsed.isLocal) {
      return res.status(400).json({ error: "Sender must be remote" });
    }

    const recipient = await prisma.user.findUnique({
      where: { username: recipientParsed.username },
      select: { id: true },
    });
    if (!recipient) {
      return res.status(404).json({ error: "Recipient not found" });
    }

    const created = await prisma.incomingQueue.create({
      data: {
        recipient_id: recipient.id,
        sender_handle: senderParsed.handle,
        encrypted_blob,
      },
    });

    serverLogger.info("federation.incoming.queued", {
      id: created.id,
      recipient_id: created.recipient_id,
      sender_handle: created.sender_handle,
      created_at: created.created_at,
    });

    io.to(recipient.id).emit("INCOMING_MESSAGE", {
      id: created.id,
      message_id: created.id,
      recipient_id: created.recipient_id,
      sender_handle: created.sender_handle,
      encrypted_blob: created.encrypted_blob,
      created_at: created.created_at.toISOString(),
    });

    return res.status(201).json({
      id: created.id,
      recipient_handle: recipientParsed.handle,
      created_at: created.created_at,
    });
  };

  router.post(
    "/api/federation/incoming",
    federationLimiter,
    verifyFederationSignature(),
    handleFederationIncoming
  );
  router.post(
    "/federation/incoming",
    federationLimiter,
    verifyFederationSignature(),
    handleFederationIncoming
  );

  router.use(authenticateToken);

  router.post("/messages/send", async (req: Request, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const {
      recipient_handle,
      encrypted_blob,
      message_id,
      event_type = "message",
      reaction_emoji,
      sender_vault_blob,
      sender_vault_iv,
      sender_vault_signature_verified,
    } = parsed.data;
    let recipientParsed;
    try {
      recipientParsed = parseHandle(recipient_handle, instanceHost);
    } catch {
      return res.status(400).json({ error: "Invalid recipient handle" });
    }

    const senderHandle = buildHandle(req.user.username, instanceHost);

    serverLogger.info("message.send.request", {
      sender_handle: senderHandle,
      recipient_handle: recipientParsed.handle,
      message_id,
      payload: sanitizeLogPayload(parsed.data),
    });

    const storeSenderVault = async () => {
      if (!sender_vault_blob || !sender_vault_iv) {
        return false;
      }
      const existing = await prisma.messageVault.findUnique({
        where: { id: message_id },
        select: { id: true, owner_id: true },
      });
      if (existing) {
        return existing.owner_id === req.user!.id;
      }
      await prisma.messageVault.create({
        data: {
          id: message_id,
          owner_id: req.user!.id,
          peer_handle: recipientParsed.handle,
          original_sender_handle: recipientParsed.handle,
          encrypted_blob: sender_vault_blob,
          iv: sender_vault_iv,
          sender_signature_verified: sender_vault_signature_verified ?? true,
        },
      });
      return true;
    };

    if (!recipientParsed.isLocal) {
      if (!(await isFederationHostAllowed(recipientParsed.host))) {
        return res.status(400).json({ error: "Invalid host" });
      }
      const payload = {
        recipient_handle: recipientParsed.handle,
        sender_handle: senderHandle,
        encrypted_blob,
      };
      const payloadJson = JSON.stringify(payload);
      const signature = signFederationPayload(payloadJson);
      const resolvedUrl =
        (await resolveFederationEndpoint(recipientParsed.host, "inbox")) ??
        (() => {
          const protocol = resolveFederationProtocol(recipientParsed.host);
          return `${protocol}://${recipientParsed.host}${federationIncomingPath}`;
        })();
      const remoteUrl = resolvedUrl;
      serverLogger.info("federation.outgoing.send", {
        remote_url: remoteUrl,
        headers: sanitizeLogPayload({
          "X-Ratchet-Host": serverHost,
          "X-Ratchet-Sig": signature,
        }),
        payload: sanitizeLogPayload(payload),
      });
      try {
        const response = await federationRequestJson(remoteUrl, {
          method: "POST",
          headers: {
            "X-Ratchet-Host": serverHost,
            "X-Ratchet-Sig": signature,
          },
          body: payloadJson,
        });
        serverLogger.info("federation.outgoing.response", {
          remote_url: remoteUrl,
          ok: response.ok,
          status: response.status,
          error: response.error,
        });
        if (!response.ok) {
          const status = response.error ? 503 : 502;
          return res.status(status).json({
            error: response.error ?? "Remote host rejected message",
          });
        }
      } catch {
        serverLogger.error("federation.outgoing.error", {
          remote_url: remoteUrl,
        });
        return res.status(502).json({ error: "Unable to reach remote host" });
      }

      const senderVaultStored = await storeSenderVault();

      // Notify other devices of the sender about the outgoing message
      if (senderVaultStored && sender_vault_blob && sender_vault_iv) {
        io.to(req.user!.id).emit("OUTGOING_MESSAGE_SYNCED", {
          message_id,
          owner_id: req.user!.id,
          original_sender_handle: recipientParsed.handle,
          encrypted_blob: sender_vault_blob,
          iv: sender_vault_iv,
          sender_signature_verified: sender_vault_signature_verified ?? true,
          created_at: new Date().toISOString(),
        });
      }

      return res.status(202).json({
        recipient_handle: recipientParsed.handle,
        relayed: true,
        sender_vault_stored: senderVaultStored,
      });
    }

    const recipient = await prisma.user.findUnique({
      where: { username: recipientParsed.username },
      select: { id: true },
    });
    if (!recipient) {
      return res.status(404).json({ error: "Recipient not found" });
    }

    const queueItem = await prisma.$transaction(async (tx) => {
      let senderVaultStored = false;

      // Queue compaction based on event type
      if (event_type === "delete") {
        // Delete ALL pending events for this message
        await tx.incomingQueue.deleteMany({
          where: {
            recipient_id: recipient.id,
            message_id,
          },
        });
      } else if (event_type === "message" || event_type === "edit") {
        // Replace existing message/edit for this message_id
        await tx.incomingQueue.deleteMany({
          where: {
            recipient_id: recipient.id,
            message_id,
            event_type: { in: ["message", "edit"] },
          },
        });
      } else if (event_type === "reaction") {
        // Replace existing reaction from same sender for same emoji
        await tx.incomingQueue.deleteMany({
          where: {
            recipient_id: recipient.id,
            message_id,
            sender_handle: senderHandle,
            event_type: "reaction",
            reaction_emoji,
          },
        });
      } else if (event_type === "key_rotation") {
        // Keep only the latest key rotation per sender
        await tx.incomingQueue.deleteMany({
          where: {
            recipient_id: recipient.id,
            sender_handle: senderHandle,
            event_type: "key_rotation",
          },
        });
      }
      // For receipts, no compaction needed - they're informational

      const created = await tx.incomingQueue.create({
        data: {
          recipient_id: recipient.id,
          sender_handle: senderHandle,
          message_id,
          event_type,
          reaction_emoji: event_type === "reaction" ? reaction_emoji : null,
          encrypted_blob,
        },
      });

      if (sender_vault_blob && sender_vault_iv) {
        const existing = await tx.messageVault.findUnique({
          where: { id: message_id },
          select: { id: true },
        });
        if (!existing) {
          await tx.messageVault.create({
            data: {
              id: message_id,
              owner_id: req.user!.id,
              peer_handle: recipientParsed.handle,
              original_sender_handle: recipientParsed.handle,
              encrypted_blob: sender_vault_blob,
              iv: sender_vault_iv,
              sender_signature_verified: sender_vault_signature_verified ?? true,
            },
          });
          senderVaultStored = true;
        } else {
          senderVaultStored = true;
        }
      }

      return { created, senderVaultStored };
    });

    serverLogger.info("message.send.queued", {
      id: queueItem.created.id,
      recipient_id: queueItem.created.recipient_id,
      sender_handle: queueItem.created.sender_handle,
      created_at: queueItem.created.created_at,
    });

    io.to(recipient.id).emit("INCOMING_MESSAGE", {
      id: queueItem.created.id,
      message_id: queueItem.created.id,
      recipient_id: queueItem.created.recipient_id,
      sender_handle: queueItem.created.sender_handle,
      encrypted_blob: queueItem.created.encrypted_blob,
      created_at: queueItem.created.created_at.toISOString(),
    });

    // Notify other devices of the sender about the outgoing message
    if (queueItem.senderVaultStored && sender_vault_blob && sender_vault_iv) {
      io.to(req.user!.id).emit("OUTGOING_MESSAGE_SYNCED", {
        message_id,
        owner_id: req.user!.id,
        original_sender_handle: recipientParsed.handle,
        encrypted_blob: sender_vault_blob,
        iv: sender_vault_iv,
        sender_signature_verified: sender_vault_signature_verified ?? true,
        created_at: queueItem.created.created_at.toISOString(),
      });
    }

    return res.status(201).json({
      id: queueItem.created.id,
      recipient_handle: recipientParsed.handle,
      created_at: queueItem.created.created_at,
      relayed: false,
      sender_vault_stored: queueItem.senderVaultStored,
    });
  });

  router.get("/messages/queue", async (req: Request, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const items = await prisma.incomingQueue.findMany({
      where: { recipient_id: req.user.id },
      orderBy: { created_at: "asc" },
    });

    return res.json(items);
  });

  router.delete("/messages/queue/:id", async (req: Request, res: Response) => {
    return res.status(405).json({
      error: "Use POST /messages/queue/:id/store to store and remove messages",
    });
  });

  router.post(
    "/messages/queue/:id/store",
    async (req: Request, res: Response) => {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const parsed = storeFromQueueSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request" });
      }

      const { id } = req.params;
      const queueItem = await prisma.incomingQueue.findUnique({
        where: { id },
      });

      if (!queueItem) {
        return res.status(404).json({ error: "Not found" });
      }

      if (queueItem.recipient_id !== req.user.id) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const { encrypted_blob, iv, sender_signature_verified } = parsed.data;
      serverLogger.info("message.queue.store.request", {
        id: queueItem.id,
        sender_handle: queueItem.sender_handle,
        recipient_id: queueItem.recipient_id,
        payload: sanitizeLogPayload({ encrypted_blob, iv, sender_signature_verified }),
      });

      let vaultEntry;
      try {
        vaultEntry = await prisma.$transaction(async (tx) => {
          // Delete first to acquire lock and fail fast if already processed
          const deleted = await tx.incomingQueue.deleteMany({
            where: { id: queueItem.id },
          });

          if (deleted.count === 0) {
            throw new Error("ALREADY_PROCESSED");
          }

          const created = await tx.messageVault.create({
            data: {
              owner_id: req.user!.id,
              original_sender_handle: queueItem.sender_handle!,
              encrypted_blob,
              iv,
              sender_signature_verified,
            },
          });

          return created;
        });
      } catch (err) {
        if (err instanceof Error && err.message === "ALREADY_PROCESSED") {
          return res.status(404).json({ error: "Queue item already processed" });
        }
        throw err;
      }

      serverLogger.info("message.queue.stored", {
        id: vaultEntry.id,
        owner_id: vaultEntry.owner_id,
        original_sender_handle: vaultEntry.original_sender_handle,
        created_at: vaultEntry.created_at,
      });

      // Notify other devices of the recipient about the stored incoming message
      io.to(req.user!.id).emit("INCOMING_MESSAGE_SYNCED", {
        id: vaultEntry.id,
        owner_id: vaultEntry.owner_id,
        original_sender_handle: vaultEntry.original_sender_handle,
        encrypted_blob: vaultEntry.encrypted_blob,
        iv: vaultEntry.iv,
        sender_signature_verified: vaultEntry.sender_signature_verified,
        created_at: vaultEntry.created_at.toISOString(),
      });

      return res.status(201).json(vaultEntry);
    },
  );

  router.post("/messages/queue/:id/ack", async (req: Request, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const queueItem = await prisma.incomingQueue.findUnique({
      where: { id },
    });

    if (!queueItem) {
      return res.status(404).json({ error: "Not found" });
    }

    if (queueItem.recipient_id !== req.user.id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    await prisma.incomingQueue.deleteMany({ where: { id } });
    serverLogger.info("message.queue.acknowledged", {
      id,
      recipient_id: queueItem.recipient_id,
      sender_handle: queueItem.sender_handle,
    });

    return res.json({ ok: true });
  });

  router.post("/messages/vault", async (req: Request, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parsed = vaultSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const {
      encrypted_blob,
      iv,
      original_sender_handle,
      sender_signature_verified,
      message_id,
    } = parsed.data;

    if (message_id) {
      // Use upsert to handle race conditions - if it exists and belongs to this user, return it
      const existing = await prisma.messageVault.findUnique({
        where: { id: message_id },
      });
      if (existing) {
        if (existing.owner_id !== req.user.id) {
          return res.status(409).json({ error: "Message id already exists" });
        }
        // Already exists for this user, return it
        return res.status(200).json(existing);
      }
    }

    let entry;
    try {
      entry = await prisma.messageVault.create({
        data: {
          ...(message_id ? { id: message_id } : {}),
          owner_id: req.user.id,
          original_sender_handle,
          encrypted_blob,
          iv,
          sender_signature_verified,
        },
      });
    } catch (err: unknown) {
      // Handle race condition - another device created it first
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "P2002" &&
        message_id
      ) {
        const existing = await prisma.messageVault.findUnique({
          where: { id: message_id },
        });
        if (existing && existing.owner_id === req.user.id) {
          return res.status(200).json(existing);
        }
        return res.status(409).json({ error: "Message id already exists" });
      }
      throw err;
    }

    serverLogger.info("message.vault.stored", {
      id: entry.id,
      owner_id: entry.owner_id,
      original_sender_handle: entry.original_sender_handle,
      created_at: entry.created_at,
    });

    const roomSockets = io.sockets.adapter.rooms.get(req.user!.id);
    console.log("[SYNC DEBUG SERVER] Emitting OUTGOING_MESSAGE_SYNCED to room:", req.user!.id, {
      message_id: entry.id,
      owner_id: entry.owner_id,
      original_sender_handle: entry.original_sender_handle,
      socketsInRoom: roomSockets ? Array.from(roomSockets) : [],
      socketCount: roomSockets?.size ?? 0,
    });
    io.to(req.user!.id).emit("OUTGOING_MESSAGE_SYNCED", {
      message_id: entry.id,
      owner_id: entry.owner_id,
      original_sender_handle: entry.original_sender_handle,
      encrypted_blob: entry.encrypted_blob,
      iv: entry.iv,
      sender_signature_verified: entry.sender_signature_verified,
      created_at: entry.created_at.toISOString(),
    });

    return res.status(201).json(entry);
  });

  router.patch("/messages/vault/:id", async (req: Request, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parsed = vaultUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const { encrypted_blob, iv, expected_version, deleted } = parsed.data;

    try {
      const updated = await prisma.$transaction(async (tx) => {
        const existing = await tx.messageVault.findUnique({
          where: { id },
          select: { id: true, owner_id: true, version: true },
        });

        if (!existing) {
          throw new Error("NOT_FOUND");
        }
        if (existing.owner_id !== req.user!.id) {
          throw new Error("FORBIDDEN");
        }

        // Optimistic locking: check version if provided
        if (expected_version !== undefined && existing.version !== expected_version) {
          throw new Error("VERSION_CONFLICT");
        }

        return tx.messageVault.update({
          where: { id },
          data: {
            encrypted_blob,
            iv,
            version: { increment: 1 },
            deleted_at: deleted ? new Date() : null,
          },
        });
      });

      serverLogger.info("message.vault.updated", {
        id: updated.id,
        owner_id: updated.owner_id,
        original_sender_handle: updated.original_sender_handle,
        version: updated.version,
        deleted: !!updated.deleted_at,
        updated_at: updated.updated_at.toISOString(),
      });

      // Notify other devices about the vault update
      io.to(req.user!.id).emit("VAULT_MESSAGE_UPDATED", {
        id: updated.id,
        encrypted_blob: updated.encrypted_blob,
        iv: updated.iv,
        version: updated.version,
        deleted_at: updated.deleted_at?.toISOString() ?? null,
        updated_at: updated.updated_at.toISOString(),
      });

      return res.json(updated);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === "NOT_FOUND") {
          return res.status(404).json({ error: "Not found" });
        }
        if (err.message === "FORBIDDEN") {
          return res.status(403).json({ error: "Forbidden" });
        }
        if (err.message === "VERSION_CONFLICT") {
          return res.status(409).json({ error: "Version conflict", code: "VERSION_CONFLICT" });
        }
      }
      throw err;
    }
  });

  router.get("/messages/vault", async (req: Request, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const orderParam = typeof req.query.order === "string" ? req.query.order : "";
    const orderDirection = orderParam === "asc" ? "asc" : "desc";
    const limitParam = typeof req.query.limit === "string" ? req.query.limit : "";
    const limitValue = limitParam ? Number(limitParam) : null;
    const take = limitValue && Number.isFinite(limitValue) && limitValue > 0
      ? Math.floor(limitValue)
      : undefined;

    const items = await prisma.messageVault.findMany({
      where: { owner_id: req.user.id },
      orderBy: { created_at: orderDirection },
      ...(take ? { take } : {}),
    });

    return res.json(items);
  });

  // Delta sync endpoint - fetch messages since a timestamp with cursor pagination
  // Uses updated_at to catch edits and deletes, not just new messages
  router.get("/messages/vault/sync", async (req: Request, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const since = typeof req.query.since === "string" ? req.query.since : null;
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
    const limitParam = typeof req.query.limit === "string" ? req.query.limit : "100";
    const limit = Math.min(Math.max(1, parseInt(limitParam, 10) || 100), 500);

    const where: {
      owner_id: string;
      updated_at?: { gt: Date };
      id?: { gt: string };
    } = {
      owner_id: req.user.id,
    };

    if (since) {
      const sinceDate = new Date(since);
      if (!Number.isNaN(sinceDate.getTime())) {
        where.updated_at = { gt: sinceDate };
      }
    }

    if (cursor) {
      where.id = { gt: cursor };
    }

    const items = await prisma.messageVault.findMany({
      where,
      orderBy: [{ updated_at: "asc" }, { id: "asc" }],
      take: limit + 1,
    });

    const hasMore = items.length > limit;
    const results = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore && results.length > 0 ? results[results.length - 1].id : null;

    return res.json({
      items: results,
      nextCursor,
      hasMore,
      syncedAt: new Date().toISOString(),
    });
  });

  // Conversation summaries - returns last message per unique peer for sidebar preview
  router.get("/messages/vault/summaries", async (req: Request, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Get the most recent non-deleted message for each unique peer_handle
    const summaries = await prisma.$queryRaw<
      Array<{
        id: string;
        peer_handle: string | null;
        original_sender_handle: string;
        encrypted_blob: string;
        iv: string;
        sender_signature_verified: boolean;
        version: number;
        created_at: Date;
        updated_at: Date;
      }>
    >`
      SELECT DISTINCT ON (COALESCE(peer_handle, original_sender_handle))
        id, peer_handle, original_sender_handle, encrypted_blob, iv,
        sender_signature_verified, version, created_at, updated_at
      FROM "MessageVault"
      WHERE owner_id = ${req.user.id}::uuid
        AND deleted_at IS NULL
      ORDER BY COALESCE(peer_handle, original_sender_handle), created_at DESC
    `;

    return res.json(summaries);
  });

const deleteChatSchema = z.object({
  peer_handle: z.string().min(1),
});

// ... inside createMessagesRouter ...

  router.post("/messages/vault/delete-chat", async (req: Request, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parsed = deleteChatSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const { peer_handle } = parsed.data;
    let peerParsed;
    try {
      peerParsed = parseHandle(peer_handle, instanceHost);
    } catch {
      return res.status(400).json({ error: "Invalid handle" });
    }

    const deleted = await prisma.messageVault.deleteMany({
      where: {
        owner_id: req.user.id,
        original_sender_handle: peerParsed.handle,
      },
    });

    return res.json({ count: deleted.count });
  });

  return router;
};
