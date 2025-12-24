import type { PrismaClient } from "@prisma/client";
import { ReceiptType } from "@prisma/client";
import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import type { Server as SocketIOServer } from "socket.io";

import { authenticateToken } from "../middleware/auth";
import {
  federationRequestJson,
  getFederationIdentity,
  getServerHost,
  resolveFederationProtocol,
  signFederationPayload,
} from "../lib/federationAuth";
import { verifyFederationSignature } from "../middleware/federation";
import { buildHandle, getInstanceHost, parseHandle } from "../lib/handles";
import { serverLogger, sanitizeLogPayload } from "../lib/logger";

const sendSchema = z.object({
  recipient_handle: z.string().min(1),
  encrypted_blob: z.string().min(1),
  message_id: z.string().uuid(),
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

const receiptSchema = z
  .object({
    recipient_id: z.string().uuid().optional(),
    recipient_handle: z.string().min(1).optional(),
    message_id: z.string().uuid(),
    type: z.nativeEnum(ReceiptType),
  })
  .refine((data) => data.recipient_id || data.recipient_handle, {
    message: "Missing recipient",
  });

const federatedReceiptSchema = z.object({
  recipient_handle: z.string().min(1),
  message_id: z.string().uuid(),
  type: z.nativeEnum(ReceiptType),
});

export const createMessagesRouter = (
  prisma: PrismaClient,
  io: SocketIOServer
) => {
  const router = Router();
  const instanceHost = getInstanceHost();
  const serverHost = getServerHost();
  const federationIncomingPath = "/api/federation/incoming";
  const federationReceiptsPath = "/api/federation/receipts";

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
    verifyFederationSignature(),
    handleFederationIncoming
  );
  router.post(
    "/federation/incoming",
    verifyFederationSignature(),
    handleFederationIncoming
  );

  const handleFederationReceipts = async (req: Request, res: Response) => {
    const parsed = federatedReceiptSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const { recipient_handle, message_id, type } = parsed.data;
    serverLogger.info("federation.receipts.received", {
      sender_host: req.headers["x-ratchet-host"],
      payload: sanitizeLogPayload({ recipient_handle, message_id, type }),
    });
    let recipientParsed;
    try {
      recipientParsed = parseHandle(recipient_handle, instanceHost);
    } catch {
      return res.status(400).json({ error: "Invalid handle" });
    }

    if (!recipientParsed.isLocal) {
      return res.status(400).json({ error: "Recipient not local" });
    }

    const recipient = await prisma.user.findUnique({
      where: { username: recipientParsed.username },
      select: { id: true },
    });
    if (!recipient) {
      return res.status(404).json({ error: "Recipient not found" });
    }

    const receipt = await prisma.receipt.create({
      data: {
        recipient_id: recipient.id,
        message_id,
        type,
      },
    });

    serverLogger.info("federation.receipts.stored", {
      recipient_id: recipient.id,
      message_id,
      type,
      timestamp: receipt.timestamp,
    });

    io.to(recipient.id).emit("RECEIPT_UPDATE", {
      message_id,
      type,
      timestamp: receipt.timestamp,
    });

    return res.status(201).json(receipt);
  };

  router.post(
    "/api/federation/receipts",
    verifyFederationSignature({ requireSenderHandle: false }),
    handleFederationReceipts
  );
  router.post(
    "/federation/receipts",
    verifyFederationSignature({ requireSenderHandle: false }),
    handleFederationReceipts
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
          original_sender_handle: recipientParsed.handle,
          encrypted_blob: sender_vault_blob,
          iv: sender_vault_iv,
          sender_signature_verified: sender_vault_signature_verified ?? true,
        },
      });
      return true;
    };

    if (!recipientParsed.isLocal) {
      const payload = {
        recipient_handle: recipientParsed.handle,
        sender_handle: senderHandle,
        encrypted_blob,
      };
      const payloadJson = JSON.stringify(payload);
      const signature = signFederationPayload(payloadJson);
      const protocol = resolveFederationProtocol(recipientParsed.host);
      const remoteUrl = `${protocol}://${recipientParsed.host}${federationIncomingPath}`;
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
      await prisma.receipt.create({
        data: {
          recipient_id: req.user.id,
          message_id,
          type: ReceiptType.DELIVERED_TO_SERVER,
        },
      });

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
      const created = await tx.incomingQueue.create({
        data: {
          recipient_id: recipient.id,
          sender_handle: senderHandle,
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

      await tx.receipt.create({
        data: {
          recipient_id: req.user!.id,
          message_id,
          type: ReceiptType.DELIVERED_TO_SERVER,
        },
      });

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
      const vaultEntry = await prisma.$transaction(async (tx) => {
        const created = await tx.messageVault.create({
          data: {
            owner_id: req.user!.id,
            original_sender_handle: queueItem.sender_handle,
            encrypted_blob,
            iv,
            sender_signature_verified,
          },
        });

        await tx.incomingQueue.delete({ where: { id: queueItem.id } });
        return created;
      });

      serverLogger.info("message.queue.stored", {
        id: vaultEntry.id,
        owner_id: vaultEntry.owner_id,
        original_sender_handle: vaultEntry.original_sender_handle,
        created_at: vaultEntry.created_at,
      });

      return res.status(201).json(vaultEntry);
    },
  );

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
      const existing = await prisma.messageVault.findUnique({
        where: { id: message_id },
        select: { id: true, owner_id: true },
      });
      if (existing) {
        if (existing.owner_id !== req.user.id) {
          return res.status(409).json({ error: "Message id already exists" });
        }
        const found = await prisma.messageVault.findUnique({
          where: { id: message_id },
        });
        if (found) {
          return res.status(200).json(found);
        }
      }
    }

    const entry = await prisma.messageVault.create({
      data: {
        ...(message_id ? { id: message_id } : {}),
        owner_id: req.user.id,
        original_sender_handle,
        encrypted_blob,
        iv,
        sender_signature_verified,
      },
    });

    serverLogger.info("message.vault.stored", {
      id: entry.id,
      owner_id: entry.owner_id,
      original_sender_handle: entry.original_sender_handle,
      created_at: entry.created_at,
    });

    return res.status(201).json(entry);
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

  router.post("/receipts", async (req: Request, res: Response) => {
    const parsed = receiptSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const { recipient_id, recipient_handle, message_id, type } = parsed.data;
    serverLogger.info("receipt.create.request", {
      recipient_id,
      recipient_handle,
      message_id,
      type,
    });
    let recipientId = recipient_id ?? null;
    if (!recipientId && recipient_handle) {
      try {
        const recipientParsed = parseHandle(recipient_handle, instanceHost);
        if (!recipientParsed.isLocal) {
          const payload = {
            recipient_handle: recipientParsed.handle,
            message_id,
            type,
          };
          const payloadJson = JSON.stringify(payload);
          const signature = signFederationPayload(payloadJson);
          const protocol = resolveFederationProtocol(recipientParsed.host);
          const remoteUrl = `${protocol}://${recipientParsed.host}${federationReceiptsPath}`;
          serverLogger.info("federation.receipts.send", {
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
            serverLogger.info("federation.receipts.response", {
              remote_url: remoteUrl,
              ok: response.ok,
              status: response.status,
              error: response.error,
            });
            if (!response.ok) {
              const status = response.error ? 503 : 502;
              return res.status(status).json({
                error: response.error ?? "Remote host rejected receipt",
              });
            }
          } catch {
            serverLogger.error("federation.receipts.error", {
              remote_url: remoteUrl,
            });
            return res
              .status(502)
              .json({ error: "Unable to reach remote host" });
          }

          return res.status(202).json({ relayed: true });
        }
        const recipient = await prisma.user.findUnique({
          where: { username: recipientParsed.username },
          select: { id: true },
        });
        recipientId = recipient?.id ?? null;
      } catch {
        return res.status(400).json({ error: "Invalid handle" });
      }
    }
    if (!recipientId) {
      return res.status(404).json({ error: "Recipient not found" });
    }
    const recipient = await prisma.user.findUnique({
      where: { id: recipientId },
      select: { id: true },
    });
    if (!recipient) {
      return res.status(404).json({ error: "Recipient not found" });
    }

    const receipt = await prisma.receipt.create({
      data: {
        recipient_id: recipientId,
        message_id,
        type,
      },
    });

    serverLogger.info("receipt.stored", {
      recipient_id: recipientId,
      message_id,
      type,
      timestamp: receipt.timestamp,
    });

    io.to(recipientId).emit("RECEIPT_UPDATE", {
      message_id,
      type,
      timestamp: receipt.timestamp,
    });

    return res.status(201).json(receipt);
  });

  router.get("/receipts", async (req: Request, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const sinceParam = typeof req.query.since === "string" ? req.query.since : null;
    let sinceDate: Date | null = null;
    if (sinceParam) {
      const parsedDate = new Date(sinceParam);
      if (!Number.isNaN(parsedDate.valueOf())) {
        sinceDate = parsedDate;
      }
    }

    const receipts = await prisma.receipt.findMany({
      where: {
        recipient_id: req.user.id,
        ...(sinceDate ? { timestamp: { gt: sinceDate } } : {}),
      },
      orderBy: { timestamp: "asc" },
    });

    return res.json(receipts);
  });

  return router;
};
