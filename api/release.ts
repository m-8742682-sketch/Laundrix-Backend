/**
 * POST /api/release  — FIXED VERSION
 *
 * Fixes:
 *  #7  Write usage record to Firestore usageHistory when session ends
 *      - reads startTime from RTDB sessions/{machineId}
 *      - calculates duration
 *      - stores {userId, machineId, startTime, endTime, duration, resultStatus}
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import { getCommandsRef, rtdb, db, machinesRef } from '../lib/firebase';
import {
  getMachine,
  setCurrentUser,
  getNextUser,
  updateNextUserId
} from '../lib/queue';
import {
  notifyYourTurn,
  notifySessionEnded,
  sendAndStoreNotification
} from '../lib/fcm';
import type { ReleaseRequest, ApiResponse, GracePeriod } from '../lib/types';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  try {
    const { machineId, userId } = req.body as ReleaseRequest;

    if (!machineId || !userId) {
      res.status(400).json({ success: false, error: 'Missing machineId or userId' });
      return;
    }

    const machine = await getMachine(machineId);
    if (!machine) {
      res.status(404).json({ success: false, error: 'Machine not found' });
      return;
    }
    if (machine.currentUserId !== userId) {
      res.status(403).json({ success: false, error: 'You are not the current user of this machine' });
      return;
    }

    // ── FIX #7: Read session start time before clearing ───────────────────────
    const endTime = new Date();
    let startTime: Date | null = null;
    let userName = 'Unknown';

    try {
      const sessionSnap = await rtdb.ref(`sessions/${machineId}`).get();
      const sessionData = sessionSnap.val();
      if (sessionData?.startTime) {
        startTime = new Date(sessionData.startTime);
      }
      // Get user name
      const userSnap = await machinesRef.firestore.collection('users').doc(userId).get();
      if (userSnap.exists) {
        const userData = userSnap.data();
        userName = userData?.displayName || userData?.name || 'Unknown';
      }
    } catch (err) {
      console.warn('[release] Could not read session data:', err);
    }

    // Clear current user and unlock door
    await Promise.all([
      setCurrentUser(machineId, null),
      unlockDoor(machineId),
    ]);

    // ── FIX #7: Write usage record to Firestore ───────────────────────────────
    if (startTime) {
      const duration = Math.round((endTime.getTime() - startTime.getTime()) / 1000); // seconds
      const usageRecord = {
        userId,
        userName,
        machineId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        duration,
        resultStatus: 'Normal' as const,
        incidentId: null,
        createdAt: endTime.toISOString(),
      };

      // Write to Firestore + clear RTDB session (fire-and-forget)
      Promise.all([
        db.collection('usageHistory').add(usageRecord),
        rtdb.ref(`sessions/${machineId}`).remove(),
      ]).catch(err => console.error('[release] usageHistory write failed:', err));
    }

    // Notify session ended
    await notifySessionEnded(userId, machineId);
    sendAndStoreNotification({
      userId,
      type: 'session_ended',
      title: '👋 Session Ended',
      body: `Your session at Machine ${machineId} has ended.`,
      data: { machineId },
    }).catch(() => {});

    // Check for next user and start grace period
    const nextUser = await getNextUser(machineId);

    if (nextUser) {
      await startGracePeriod(machineId, nextUser.userId);
      notifyYourTurn(nextUser.userId, machineId).catch(() => {});
      sendAndStoreNotification({
        userId: nextUser.userId,
        type: 'your_turn',
        title: '🎉 Your Turn!',
        body: `Machine ${machineId} is ready! You have 5 minutes to scan in.`,
        data: { machineId },
        sound: 'alarm',
        priority: 'high',
      }).catch(() => {});

      res.status(200).json({
        success: true,
        message: 'Session ended. Next user has been notified.',
        data: {
          released: true,
          nextUserId: nextUser.userId,
          nextUserName: nextUser.name,
          gracePeriodMinutes: 5,
        },
      });
    } else {
      res.status(200).json({
        success: true,
        message: 'Session ended. Machine is now available.',
        data: { released: true, nextUserId: null, status: 'Available' },
      });
    }

  } catch (error) {
    console.error('Release error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

async function unlockDoor(machineId: string): Promise<void> {
  const commandsRef = getCommandsRef(machineId);
  await commandsRef.update({
    unlock: true,
    release: true,
    unlockAt: new Date().toISOString(),
  });
}

async function startGracePeriod(machineId: string, userId: string): Promise<void> {
  const now = new Date();
  const warningAt = new Date(now.getTime() + 2 * 60 * 1000);
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes

  const gracePeriod: GracePeriod = {
    machineId,
    userId,
    startedAt: now.toISOString(),
    warningAt: warningAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    warningSent: false,
    status: 'active',
  };

  await rtdb.ref(`gracePeriods/${machineId}`).set(gracePeriod);
  console.log(`[release] Grace period started for ${userId} on ${machineId} — expires in 5 min`);
}
