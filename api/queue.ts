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
import { rtdb } from '../lib/firebase';
import { startGracePeriod } from '../lib/grace';

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
  const { machinesRef: mRef, queuesRef: qRef } = await import('../lib/firebase').then(m => ({
    machinesRef: m.machinesRef,
    queuesRef: m.queuesRef,
  }));

  // All reads in parallel — machine, user, and queues fetched simultaneously
  const [machine, user, allMachinesSnap, allQueuesSnap] = await Promise.all([
    getMachine(machineId),
    getUser(userId),
    mRef.where('currentUserId', '==', userId).get(),
    qRef.get(),
  ]);

  if (!machine) {
    res.status(404).json({ success: false, error: 'Machine not found' });
    return;
  }
  if (!user) {
    res.status(404).json({ success: false, error: 'User not found' });
    return;
  }
  if (machine.currentUserId === userId) {
    res.status(400).json({ success: false, error: 'You are currently using this machine', code: 'ALREADY_CURRENT_USER' });
    return;
  }

  // Check queues from the already-fetched allQueuesSnap (no extra reads needed)
  const thisQueueDoc = allQueuesSnap.docs.find(d => d.id === machineId);
  const thisQueueUsers: any[] = thisQueueDoc?.data()?.users ?? [];
  const userInQueue = thisQueueUsers.some((u: any) => u.userId === userId);

  if (userInQueue) {
    res.status(400).json({ success: false, error: 'Already in queue for this machine', code: 'ALREADY_IN_QUEUE' });
    return;
  }

  // ── One-machine-one-queue enforcement ─────────────────────────────────────
  if (!allMachinesSnap.empty) {
    const otherMachineId = allMachinesSnap.docs[0].id;
    res.status(400).json({
      success: false,
      error: `You are already using Machine ${otherMachineId}. Please complete your current session first.`,
      code: 'ALREADY_USING_MACHINE',
    });
    return;
  }
  // Check if user is already in a queue for any OTHER machine (from already-fetched snap)
  for (const qDoc of allQueuesSnap.docs) {
    if (qDoc.id === machineId) continue;
    const users: any[] = qDoc.data()?.users ?? [];
    if (users.some((u: any) => u.userId === userId)) {
      res.status(400).json({
        success: false,
        error: `You are already in the queue for Machine ${qDoc.id}. Leave that queue first.`,
        code: 'ALREADY_IN_OTHER_QUEUE',
      });
      return;
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

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

  // Situation A: machine is free + user is now at position 1 → start grace immediately
  const isMachineFree = !machine.currentUserId;
  const isFirstInQueue = queueUser.position === 1;
  const resolvedName = userName || (user as any).displayName || (user as any).name || 'Unknown';

  const backgroundTasks: Promise<any>[] = [
    updateNextUserId(machineId),
    sendAndStoreNotification({
      userId,
      type: 'queue_joined',
      title: '✅ Joined Queue',
      body: `You are #${queueUser.position} in line for Machine ${machineId}.`,
      data: { machineId, position: queueUser.position.toString() },
    }),
  ];

  if (isMachineFree && isFirstInQueue) {
    backgroundTasks.push(
      startGracePeriod(machineId, userId, resolvedName),
      sendAndStoreNotification({
        userId,
        type: 'your_turn',
        title: '🎉 Your Turn!',
        body: `Machine ${machineId} is ready! You have 5 minutes to scan in.`,
        data: { machineId },
        sound: 'alarm',
        priority: 'high',
      })
    );
  }

  Promise.all(backgroundTasks).catch((err) => console.error('[queue/join] background error:', err));

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

  // ── BUG FIX (Bug 2 & 3): Immediately expire grace period if user leaves during grace
  // This ensures all clients (admin modal, dashboard card, queue card) dismiss at once
  // rather than waiting for the cron job (up to 1 min delay).
  let graceExpired = false;
  try {
    const graceRef  = rtdb.ref(`gracePeriods/${machineId}`);
    const graceSnap = await graceRef.get();
    if (graceSnap.exists()) {
      const grace = graceSnap.val();
      if (grace?.userId === userId && grace?.status === 'active') {
        // Mark expired first (all RTDB listeners dismiss their modals)
        await graceRef.update({ status: 'expired', expiredAt: new Date().toISOString() });
        // Then immediately delete the node (no setTimeout — serverless functions don't keep alive)
        await graceRef.remove();
        graceExpired = true;
        console.log(`[queue/leave] Grace period expired immediately for ${userId} on ${machineId}`);
      }
    }
  } catch (graceError) {
    console.warn('[queue/leave] Grace cleanup failed (non-fatal):', graceError);
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

  console.log(`User ${userId} left queue for ${machineId}${graceExpired ? ' (grace expired)' : ''}`);

  res.status(200).json({ success: true, message: 'Successfully left the queue', data: { graceExpired } });
}

// startGracePeriod is imported from lib/grace.ts