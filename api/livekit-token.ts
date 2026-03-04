/**
 * POST /api/livekit-token
 *
 * Generates a LiveKit JWT access token for a participant to join a call room.
 *
 * Body:
 *   roomName        - the callId (Firebase call document ID used as room name)
 *   participantId   - the user's Firebase UID
 *   participantName - the user's display name
 *   isVideo         - boolean (optional metadata)
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleCors } from "../lib/cors";
import { AccessToken } from "livekit-server-sdk";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (handleCors(req, res)) return;

  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "Method not allowed" });
    return;
  }

  const { roomName, participantId, participantName } = req.body as {
    roomName: string;
    participantId: string;
    participantName: string;
    isVideo?: boolean;
  };

  if (!roomName || !participantId || !participantName) {
    res.status(400).json({
      success: false,
      error: "Missing required fields: roomName, participantId, participantName",
    });
    return;
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    console.error("[livekit-token] Missing LIVEKIT_API_KEY or LIVEKIT_API_SECRET");
    res.status(500).json({ success: false, error: "LiveKit credentials not configured" });
    return;
  }

  try {
    const token = new AccessToken(apiKey, apiSecret, {
      identity: participantId,
      name: participantName,
      ttl: "2h",
    });

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const jwt = await token.toJwt();

    res.status(200).json({
      success: true,
      token: jwt,
      roomName,
      participantId,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[livekit-token] Error generating token:", err);
    res.status(500).json({ success: false, error: "Failed to generate token", message });
  }
}