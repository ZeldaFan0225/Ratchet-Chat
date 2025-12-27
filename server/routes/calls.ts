import type { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { createAuthenticateToken } from "../middleware/auth";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
];

export function createCallsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const authenticateToken = createAuthenticateToken(prisma);

  // Get ICE server configuration
  router.get("/ice-config", authenticateToken, (_req, res) => {
    // In the future, this can return TURN credentials with time-limited access
    res.json({
      iceServers: ICE_SERVERS,
    });
  });

  // Get call history
  router.get("/history", authenticateToken, async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;

    try {
      const calls = await prisma.call.findMany({
        where: {
          OR: [{ caller_id: userId }, { callee_id: userId }],
        },
        orderBy: { created_at: "desc" },
        take: limit,
        skip: offset,
        include: {
          caller: {
            select: { username: true },
          },
          callee: {
            select: { username: true },
          },
        },
      });

      const formattedCalls = calls.map((call) => {
        const isCaller = call.caller_id === userId;
        const peerUsername = isCaller ? call.callee.username : call.caller.username;
        const direction = isCaller ? "outgoing" : "incoming";

        let duration: number | null = null;
        if (call.started_at && call.ended_at) {
          duration = Math.round(
            (call.ended_at.getTime() - call.started_at.getTime()) / 1000
          );
        }

        return {
          id: call.id,
          peer_username: peerUsername,
          direction,
          call_type: call.call_type,
          status: call.status,
          end_reason: call.end_reason,
          duration,
          created_at: call.created_at.toISOString(),
          started_at: call.started_at?.toISOString() || null,
          ended_at: call.ended_at?.toISOString() || null,
        };
      });

      res.json({ calls: formattedCalls });
    } catch (error) {
      console.error("Error fetching call history:", error);
      res.status(500).json({ error: "Failed to fetch call history" });
    }
  });

  // Get a specific call
  router.get("/:callId", authenticateToken, async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { callId } = req.params;

    try {
      const call = await prisma.call.findUnique({
        where: { id: callId },
        include: {
          caller: {
            select: { username: true },
          },
          callee: {
            select: { username: true },
          },
        },
      });

      if (!call) {
        return res.status(404).json({ error: "Call not found" });
      }

      // Only allow access to calls the user participated in
      if (call.caller_id !== userId && call.callee_id !== userId) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const isCaller = call.caller_id === userId;
      const peerUsername = isCaller ? call.callee.username : call.caller.username;
      const direction = isCaller ? "outgoing" : "incoming";

      let duration: number | null = null;
      if (call.started_at && call.ended_at) {
        duration = Math.round(
          (call.ended_at.getTime() - call.started_at.getTime()) / 1000
        );
      }

      res.json({
        id: call.id,
        peer_username: peerUsername,
        direction,
        call_type: call.call_type,
        status: call.status,
        end_reason: call.end_reason,
        duration,
        created_at: call.created_at.toISOString(),
        started_at: call.started_at?.toISOString() || null,
        ended_at: call.ended_at?.toISOString() || null,
      });
    } catch (error) {
      console.error("Error fetching call:", error);
      res.status(500).json({ error: "Failed to fetch call" });
    }
  });

  return router;
}
