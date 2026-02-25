/**
 * POST /api/queue
 *
 * Unified queue endpoint — replaces /api/join-queue and /api/leave-queue
 *
 * Request body: { action: "join" | "leave", machineId: string, userId: string, userName?: string, idempotencyKey?: string }
 *
 * This saves one Vercel function slot (free tier = 12 max).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import {
  getMachine,
  getUser,
  addUserToQueue,
  isUserInQueue,
  updateNextUserId,
  removeUserFromQueue,
} from '../lib/queue';
import { sendAndStoreNotification } from '../lib/fcm';

// ─── Types ────────────────────────────────────────────────────────────────────

interface QueueRequest {
  action: 'join' | 'leave';
  machineId: string;
  userId: string;
  userName?: string;
  idempotencyKey?: string;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (handleCors(req, res)) return;

  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  const { action, machineId, userId, userName, idempotencyKey } =
    req.body as QueueRequest;

  if (!action || !machineId || !userId) {
    res.status(400).json({ success: false, error: 'Missing action, machineId, or userId' });
    return;
  }

  try {
    if (action === 'join') {
      return await handleJoin(req, res, machineId, userId, userName, idempotencyKey);
    }
    if (action === 'leave') {
      return await handleLeave(req, res, machineId, userId);
    }

    res.status(400).json({ success: false, error: 'Invalid action. Use "join" or "leave"' });
  } catch (error) {
    console.error(`[queue/${action}] error:`, error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Join ─────────────────────────────────────────────────────────────────────

async function handleJoin(
  _req: VercelRequest,
  res: VercelResponse,
  machineId: string,
  userId: string,
  userName?: string,
  idempotencyKey?: string
): Promise<void> {
  const [machine, user, userInQueue] = await Promise.all([
    getMachine(machineId),
    getUser(userId),
    isUserInQueue(machineId, userId),
  ]);

  if (!machine) {
    res.status(404).json({ success: false, error: 'Machine not found' });
    return;
  }
  if (!user) {
    res.status(404).json({ success: false, error: 'User not found' });
    return;
  }
  if (userInQueue) {
    res.status(400).json({
      success: false,
      error: 'Already in queue for this machine',
      code: 'ALREADY_IN_QUEUE',
    });
    return;
  }
  if (machine.currentUserId === userId) {
    res.status(400).json({
      success: false,
      error: 'You are currently using this machine',
      code: 'ALREADY_CURRENT_USER',
    });
    return;
  }

  const queueUser = await addUserToQueue(
    machineId,
    userId,
    userName || user.displayName || user.name || 'Unknown',
    user.photoURL || user.avatar || null,
    idempotencyKey
  );

  if (!queueUser) {
    res.status(500).json({ success: false, error: 'Failed to add to queue' });
    return;
  }

  // Background: update nextUserId + send notification
  Promise.all([
    updateNextUserId(machineId),
    sendAndStoreNotification({
      userId,
      type: 'queue_joined',
      title: '✅ Joined Queue',
      body: `You are #${queueUser.position} in line for Machine ${machineId}.`,
      data: { machineId, position: queueUser.position.toString() },
    }),
  ]).catch((err) => console.error('[queue/join] background error:', err));

  console.log(`User ${userId} joined queue for ${machineId} at position ${queueUser.position}`);

  res.status(200).json({
    success: true,
    message: `Joined queue at position ${queueUser.position}`,
    data: {
      position: queueUser.position,
      queueToken: queueUser.queueToken,
      joinedAt: queueUser.joinedAt,
    },
  });
}

// ─── Leave ────────────────────────────────────────────────────────────────────

async function handleLeave(
  _req: VercelRequest,
  res: VercelResponse,
  machineId: string,
  userId: string
): Promise<void> {
  const userInQueue = await isUserInQueue(machineId, userId);
  if (!userInQueue) {
    res.status(400).json({ success: false, error: 'Not in queue for this machine' });
    return;
  }

  const removed = await removeUserFromQueue(machineId, userId);
  if (!removed) {
    res.status(500).json({ success: false, error: 'Failed to leave queue' });
    return;
  }

  // Background: update nextUserId + notify
  Promise.all([
    updateNextUserId(machineId),
    sendAndStoreNotification({
      userId,
      type: 'queue_left',
      title: '👋 Left Queue',
      body: `You've left the queue for Machine ${machineId}.`,
      data: { machineId },
    }),
  ]).catch((err) => console.error('[queue/leave] background error:', err));

  console.log(`User ${userId} left queue for ${machineId}`);

  res.status(200).json({ success: true, message: 'Successfully left the queue' });
}
