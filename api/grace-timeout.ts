/**
 * POST /api/grace-timeout
 *
 * Called ONLY by the server-side cron job when grace period expires.
 * NOT called by the client anymore — this eliminates the "remove 5 times" bug
 * that occurred when multiple clients all called this endpoint simultaneously.
 *
 * Body: { machineId: string, userId: string, timeoutType: "warning" | "expired" }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import { rtdb } from '../lib/firebase';
import { getNextUser, removeUserFromQueue, updateNextUserId } from '../lib/queue';
import { notifyGraceWarning, notifyYourTurn, sendAndStoreNotification } from '../lib/fcm';
import { startGracePeriod, expireGracePeriod } from '../lib/grace';
import type { GraceTimeoutRequest, ApiResponse, GracePeriod } from '../lib/types';

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
    const { machineId, userId, timeoutType } = req.body as GraceTimeoutRequest;

    if (!machineId || !userId || !timeoutType) {
      res.status(400).json({ success: false, error: 'Missing machineId, userId, or timeoutType' });
      return;
    }

    const gracePeriodRef      = rtdb.ref(`gracePeriods/${machineId}`);
    const gracePeriodSnapshot = await gracePeriodRef.get();

    if (!gracePeriodSnapshot.exists()) {
      res.status(404).json({ success: false, error: 'No active grace period for this machine' });
      return;
    }

    const gracePeriod = gracePeriodSnapshot.val() as GracePeriod;

    if (gracePeriod.userId !== userId) {
      res.status(403).json({ success: false, error: 'Grace period is for a different user' });
      return;
    }

    if (gracePeriod.status !== 'active') {
      res.status(400).json({ success: false, error: `Grace period already ${gracePeriod.status}` });
      return;
    }

    // ── Warning (2 min mark) ──────────────────────────────────────────────────
    if (timeoutType === 'warning') {
      if (gracePeriod.warningSent) {
        res.status(200).json({ success: true, message: 'Warning already sent', data: { warningSent: false } });
        return;
      }
      await gracePeriodRef.update({ warningSent: true });
      await notifyGraceWarning(userId, machineId);
      await sendAndStoreNotification({
        userId,
        type: 'grace_warning',
        title: '⚠️ Hurry Up!',
        body: `Only 3 minutes left to claim Machine ${machineId}!`,
        data: { machineId },
        sound: 'urgent',
        priority: 'high',
      });
      res.status(200).json({ success: true, message: 'Warning sent', data: { warningSent: true, minutesRemaining: 3 } });
      return;
    }

    // ── Expired (5 min mark) ──────────────────────────────────────────────────
    if (timeoutType === 'expired') {
      // Mark expired (clients will dismiss modals and stop alarms via RTDB listener)
      await expireGracePeriod(machineId);

      // Remove from queue — ONCE, here only
      await removeUserFromQueue(machineId, userId);

      // Notify removed user — ONCE
      await sendAndStoreNotification({
        userId,
        type: 'removed_from_queue',
        title: '❌ Removed from Queue',
        body: `You were removed from Machine ${machineId} queue due to timeout.`,
        data: { machineId },
        priority: 'normal',
      });

      // Update nextUserId and promote next user
      await updateNextUserId(machineId);
      const nextUser = await getNextUser(machineId);

      if (nextUser) {
        // Start fresh grace period for next user
        await startGracePeriod(machineId, nextUser.userId, nextUser.name || 'Unknown');
        await notifyYourTurn(nextUser.userId, machineId);
        await sendAndStoreNotification({
          userId: nextUser.userId,
          type: 'your_turn',
          title: '🎉 Your Turn!',
          body: `Machine ${machineId} is ready for you. You have 5 minutes!`,
          data: { machineId },
          sound: 'alarm',
          priority: 'high',
        });
        res.status(200).json({ success: true, message: 'User removed, next user promoted', data: { nextUserId: nextUser.userId } });
      } else {
        res.status(200).json({ success: true, message: 'User removed, queue empty', data: { nextUserId: null } });
      }
      return;
    }

    res.status(400).json({ success: false, error: 'Invalid timeoutType. Use: warning or expired' });

  } catch (error) {
    console.error('[grace-timeout] error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}
