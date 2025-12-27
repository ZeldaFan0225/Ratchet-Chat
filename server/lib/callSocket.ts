import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import { getJwtSecret, hashToken, type AuthenticatedUser } from "../middleware/auth";
import { getServerHost } from "./federationAuth";

interface CallWebSocket extends WebSocket {
  user?: AuthenticatedUser;
  sessionId?: string;
  isAlive?: boolean;
}

interface ConnectedClients {
  [userId: string]: Set<CallWebSocket>;
}

type CallSignalMessage =
  | { type: "call:initiate"; recipient_handle: string; call_type: "AUDIO" | "VIDEO"; encrypted_offer: string }
  | { type: "call:answer"; call_id: string; encrypted_answer: string }
  | { type: "call:ice-candidate"; call_id: string; encrypted_candidate: string }
  | { type: "call:reject"; call_id: string; reason?: string }
  | { type: "call:end"; call_id: string; reason?: string }
  | { type: "call:ringing"; call_id: string };

type OutgoingMessage =
  | { type: "call:initiated"; call_id: string }
  | { type: "call:incoming"; call_id: string; caller_handle: string; caller_public_key: string; call_type: "AUDIO" | "VIDEO"; encrypted_offer: string }
  | { type: "call:answer"; call_id: string; encrypted_answer: string }
  | { type: "call:ice-candidate"; call_id: string; encrypted_candidate: string }
  | { type: "call:rejected"; call_id: string; reason?: string }
  | { type: "call:ended"; call_id: string; reason?: string }
  | { type: "call:ringing"; call_id: string }
  | { type: "call:failed"; call_id?: string; reason: string }
  | { type: "error"; message: string };

const connectedClients: ConnectedClients = {};
const activeCalls = new Map<string, { callerId: string; calleeId: string; status: string }>();

function log(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const prefix = `[CallSocket ${timestamp}]`;
  if (data) {
    console[level](prefix, message, JSON.stringify(data, null, 2));
  } else {
    console[level](prefix, message);
  }
}

export function setupCallWebSocket(
  wss: WebSocketServer,
  prisma: PrismaClient
): void {
  // Heartbeat to detect stale connections
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const callWs = ws as CallWebSocket;
      if (callWs.isAlive === false) {
        removeClientFromRoom(callWs);
        return callWs.terminate();
      }
      callWs.isAlive = false;
      callWs.ping();
    });
  }, 30000);

  wss.on("close", () => {
    clearInterval(heartbeatInterval);
  });

  wss.on("connection", async (ws: CallWebSocket, req: IncomingMessage) => {
    const clientIp = req.socket.remoteAddress;
    log("info", "New WebSocket connection attempt", { clientIp });

    ws.isAlive = true;

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    // Authenticate from URL query parameter
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const token = url.searchParams.get("token");

    if (!token) {
      log("warn", "Connection rejected: No token provided", { clientIp });
      sendMessage(ws, { type: "error", message: "Unauthorized: No token provided" });
      ws.close(4001, "Unauthorized");
      return;
    }

    try {
      const secret = getJwtSecret();
      const payload = jwt.verify(token, secret) as jwt.JwtPayload;

      if (!payload.sub || typeof payload.sub !== "string") {
        sendMessage(ws, { type: "error", message: "Unauthorized: Invalid token" });
        ws.close(4001, "Unauthorized");
        return;
      }

      // Validate session exists in database
      const tokenHash = hashToken(token);
      const session = await prisma.session.findUnique({
        where: { token_hash: tokenHash },
        select: { id: true, expires_at: true },
      });

      if (!session) {
        sendMessage(ws, { type: "error", message: "Session invalidated" });
        ws.close(4002, "Session invalidated");
        return;
      }

      if (session.expires_at < new Date()) {
        await prisma.session.delete({ where: { id: session.id } });
        sendMessage(ws, { type: "error", message: "Session expired" });
        ws.close(4003, "Session expired");
        return;
      }

      const username = typeof payload.username === "string" ? payload.username : "";
      ws.user = { id: payload.sub, username };
      ws.sessionId = session.id;

      // Add to connected clients room
      addClientToRoom(ws, payload.sub);
      log("info", "Client authenticated and connected", { userId: payload.sub, username });

      ws.on("message", async (data) => {
        try {
          const message = JSON.parse(data.toString()) as CallSignalMessage;
          log("info", "Received message", { userId: ws.user?.id, type: message.type });
          await handleCallMessage(ws, message, prisma);
        } catch (error) {
          log("error", "Failed to parse message", { userId: ws.user?.id, error: String(error) });
          sendMessage(ws, { type: "error", message: "Invalid message format" });
        }
      });

      ws.on("close", (code, reason) => {
        log("info", "Client disconnected", { userId: ws.user?.id, code, reason: reason.toString() });
        handleDisconnect(ws, prisma);
        removeClientFromRoom(ws);
      });

      ws.on("error", (error) => {
        log("error", "WebSocket error", { userId: ws.user?.id, error: String(error) });
        handleDisconnect(ws, prisma);
        removeClientFromRoom(ws);
      });
    } catch (error) {
      log("error", "Authentication failed", { error: String(error) });
      sendMessage(ws, { type: "error", message: "Unauthorized: Token verification failed" });
      ws.close(4001, "Unauthorized");
    }
  });
}

function addClientToRoom(ws: CallWebSocket, userId: string): void {
  if (!connectedClients[userId]) {
    connectedClients[userId] = new Set();
  }
  connectedClients[userId].add(ws);
}

function removeClientFromRoom(ws: CallWebSocket): void {
  if (ws.user?.id && connectedClients[ws.user.id]) {
    connectedClients[ws.user.id].delete(ws);
    if (connectedClients[ws.user.id].size === 0) {
      delete connectedClients[ws.user.id];
    }
  }
}

function sendToUser(userId: string, message: OutgoingMessage): boolean {
  const clients = connectedClients[userId];
  if (!clients || clients.size === 0) {
    log("warn", "Cannot send to user: not connected", { userId, messageType: message.type });
    return false;
  }

  const messageStr = JSON.stringify(message);
  let sentCount = 0;
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
      sentCount++;
    }
  });
  log("info", "Sent message to user", { userId, messageType: message.type, clientCount: sentCount });
  return true;
}

function sendMessage(ws: CallWebSocket, message: OutgoingMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    log("info", "Sending message to client", { userId: ws.user?.id, messageType: message.type });
    ws.send(JSON.stringify(message));
  } else {
    log("warn", "Cannot send message: socket not open", { userId: ws.user?.id, messageType: message.type, readyState: ws.readyState });
  }
}

async function handleCallMessage(
  ws: CallWebSocket,
  message: CallSignalMessage,
  prisma: PrismaClient
): Promise<void> {
  const user = ws.user;
  if (!user?.id) return;

  switch (message.type) {
    case "call:initiate":
      await handleCallInitiate(ws, user, message, prisma);
      break;
    case "call:answer":
      await handleCallAnswer(ws, user, message, prisma);
      break;
    case "call:ice-candidate":
      await handleIceCandidate(ws, user, message, prisma);
      break;
    case "call:reject":
      await handleCallReject(ws, user, message, prisma);
      break;
    case "call:end":
      await handleCallEnd(ws, user, message, prisma);
      break;
    case "call:ringing":
      await handleCallRinging(ws, user, message, prisma);
      break;
  }
}

async function handleCallInitiate(
  ws: CallWebSocket,
  user: AuthenticatedUser,
  message: Extract<CallSignalMessage, { type: "call:initiate" }>,
  prisma: PrismaClient
): Promise<void> {
  const { recipient_handle, call_type, encrypted_offer } = message;

  // Parse recipient handle (username@host)
  const parts = recipient_handle.split("@");
  const username = parts[0];
  const host = parts[1];
  const serverHost = getServerHost();

  // For now, only support local calls (federation TBD)
  if (host && host !== serverHost) {
    sendMessage(ws, { type: "call:failed", reason: "federated_calls_not_supported" });
    return;
  }

  // Look up recipient
  const recipient = await prisma.user.findUnique({
    where: { username },
    select: { id: true, public_transport_key: true },
  });

  if (!recipient) {
    sendMessage(ws, { type: "call:failed", reason: "user_not_found" });
    return;
  }

  // Check if recipient is online
  if (!connectedClients[recipient.id] || connectedClients[recipient.id].size === 0) {
    sendMessage(ws, { type: "call:failed", reason: "user_offline" });
    return;
  }

  // Check if user is already in a call
  for (const [callId, call] of activeCalls) {
    if (
      (call.callerId === user.id || call.calleeId === user.id) &&
      call.status !== "ENDED"
    ) {
      sendMessage(ws, { type: "call:failed", reason: "already_in_call" });
      return;
    }
    if (
      (call.callerId === recipient.id || call.calleeId === recipient.id) &&
      call.status !== "ENDED"
    ) {
      sendMessage(ws, { type: "call:failed", reason: "recipient_busy" });
      return;
    }
  }

  // Create call record
  const call = await prisma.call.create({
    data: {
      caller_id: user.id,
      callee_id: recipient.id,
      call_type,
      status: "INITIATED",
    },
  });

  // Track active call
  activeCalls.set(call.id, {
    callerId: user.id,
    calleeId: recipient.id,
    status: "INITIATED",
  });

  // Get caller's public key for callee
  const caller = await prisma.user.findUnique({
    where: { id: user.id },
    select: { public_transport_key: true },
  });

  log("info", "Call keys", {
    callId: call.id,
    callerUsername: user.username,
    callerPublicKeyLength: caller?.public_transport_key?.length ?? 0,
    callerPublicKeyPrefix: caller?.public_transport_key?.substring(0, 50),
    recipientUsername: username,
    recipientPublicKeyLength: recipient.public_transport_key?.length ?? 0,
    recipientPublicKeyPrefix: recipient.public_transport_key?.substring(0, 50),
  });

  // Send call_id back to caller so they can end/cancel
  sendMessage(ws, {
    type: "call:initiated",
    call_id: call.id,
  });

  // Send to recipient
  const sent = sendToUser(recipient.id, {
    type: "call:incoming",
    call_id: call.id,
    caller_handle: `${user.username}@${serverHost}`,
    caller_public_key: caller?.public_transport_key || "",
    call_type,
    encrypted_offer,
  });

  if (!sent) {
    // Recipient went offline between check and send
    activeCalls.delete(call.id);
    await prisma.call.update({
      where: { id: call.id },
      data: { status: "MISSED", end_reason: "TIMEOUT" },
    });
    sendMessage(ws, { type: "call:failed", call_id: call.id, reason: "user_offline" });
    return;
  }

  // Set up timeout for no answer (60 seconds)
  setTimeout(async () => {
    const activeCall = activeCalls.get(call.id);
    if (activeCall && activeCall.status === "INITIATED") {
      activeCalls.delete(call.id);
      await prisma.call.update({
        where: { id: call.id },
        data: { status: "MISSED", end_reason: "TIMEOUT" },
      });
      sendToUser(user.id, { type: "call:failed", call_id: call.id, reason: "no_answer" });
      sendToUser(recipient.id, { type: "call:ended", call_id: call.id, reason: "timeout" });
    }
  }, 60000);
}

async function handleCallAnswer(
  ws: CallWebSocket,
  user: AuthenticatedUser,
  message: Extract<CallSignalMessage, { type: "call:answer" }>,
  prisma: PrismaClient
): Promise<void> {
  const { call_id, encrypted_answer } = message;

  const activeCall = activeCalls.get(call_id);
  if (!activeCall || activeCall.calleeId !== user.id) {
    sendMessage(ws, { type: "error", message: "Invalid call" });
    return;
  }

  // Update call status
  activeCalls.set(call_id, { ...activeCall, status: "CONNECTED" });
  await prisma.call.update({
    where: { id: call_id },
    data: { status: "CONNECTED", started_at: new Date() },
  });

  // Forward answer to caller
  sendToUser(activeCall.callerId, {
    type: "call:answer",
    call_id,
    encrypted_answer,
  });
}

async function handleIceCandidate(
  ws: CallWebSocket,
  user: AuthenticatedUser,
  message: Extract<CallSignalMessage, { type: "call:ice-candidate" }>,
  prisma: PrismaClient
): Promise<void> {
  const { call_id, encrypted_candidate } = message;

  const activeCall = activeCalls.get(call_id);
  if (!activeCall) {
    return; // Silently ignore for disconnected calls
  }

  // Determine recipient (opposite of sender)
  const recipientId =
    activeCall.callerId === user.id ? activeCall.calleeId : activeCall.callerId;

  sendToUser(recipientId, {
    type: "call:ice-candidate",
    call_id,
    encrypted_candidate,
  });
}

async function handleCallReject(
  ws: CallWebSocket,
  user: AuthenticatedUser,
  message: Extract<CallSignalMessage, { type: "call:reject" }>,
  prisma: PrismaClient
): Promise<void> {
  const { call_id, reason } = message;

  const activeCall = activeCalls.get(call_id);
  if (!activeCall) {
    return;
  }

  const endReason = reason === "busy" ? "BUSY" : "DECLINED";

  activeCalls.delete(call_id);
  await prisma.call.update({
    where: { id: call_id },
    data: {
      status: "REJECTED",
      end_reason: endReason,
      ended_at: new Date(),
    },
  });

  // Notify caller
  sendToUser(activeCall.callerId, {
    type: "call:rejected",
    call_id,
    reason: endReason,
  });
}

async function handleCallEnd(
  ws: CallWebSocket,
  user: AuthenticatedUser,
  message: Extract<CallSignalMessage, { type: "call:end" }>,
  prisma: PrismaClient
): Promise<void> {
  const { call_id, reason } = message;

  const activeCall = activeCalls.get(call_id);
  if (!activeCall) {
    return;
  }

  activeCalls.delete(call_id);

  const call = await prisma.call.findUnique({
    where: { id: call_id },
    select: { started_at: true, status: true },
  });

  const wasConnected = call?.status === "CONNECTED";
  const endReason = wasConnected ? "COMPLETED" : "CANCELLED";

  await prisma.call.update({
    where: { id: call_id },
    data: {
      status: "ENDED",
      end_reason: reason || endReason,
      ended_at: new Date(),
    },
  });

  // Notify the other party
  const recipientId =
    activeCall.callerId === user.id ? activeCall.calleeId : activeCall.callerId;

  sendToUser(recipientId, {
    type: "call:ended",
    call_id,
    reason: reason || endReason,
  });
}

async function handleCallRinging(
  ws: CallWebSocket,
  user: AuthenticatedUser,
  message: Extract<CallSignalMessage, { type: "call:ringing" }>,
  prisma: PrismaClient
): Promise<void> {
  const { call_id } = message;

  const activeCall = activeCalls.get(call_id);
  if (!activeCall || activeCall.calleeId !== user.id) {
    return;
  }

  // Update status
  activeCalls.set(call_id, { ...activeCall, status: "RINGING" });
  await prisma.call.update({
    where: { id: call_id },
    data: { status: "RINGING" },
  });

  // Notify caller
  sendToUser(activeCall.callerId, {
    type: "call:ringing",
    call_id,
  });
}

async function handleDisconnect(
  ws: CallWebSocket,
  prisma: PrismaClient
): Promise<void> {
  const user = ws.user;
  if (!user?.id) return;

  // End any active calls for this user
  for (const [callId, call] of activeCalls) {
    if (
      (call.callerId === user.id || call.calleeId === user.id) &&
      call.status !== "ENDED"
    ) {
      activeCalls.delete(callId);

      const dbCall = await prisma.call.findUnique({
        where: { id: callId },
        select: { status: true },
      });

      const wasConnected = dbCall?.status === "CONNECTED";

      await prisma.call.update({
        where: { id: callId },
        data: {
          status: "ENDED",
          end_reason: wasConnected ? "COMPLETED" : "ERROR",
          ended_at: new Date(),
        },
      });

      // Notify the other party
      const recipientId = call.callerId === user.id ? call.calleeId : call.callerId;
      sendToUser(recipientId, {
        type: "call:ended",
        call_id: callId,
        reason: "peer_disconnected",
      });
    }
  }
}

export function createCallWebSocketServer(
  httpServer: import("http").Server | import("https").Server,
  prisma: PrismaClient
): WebSocketServer {
  log("info", "Creating Call WebSocket server on path /call");

  const wss = new WebSocketServer({
    server: httpServer,
    path: "/call",
  });

  wss.on("error", (error) => {
    log("error", "WebSocket server error", { error: String(error) });
  });

  setupCallWebSocket(wss, prisma);

  log("info", "Call WebSocket server initialized");
  return wss;
}
