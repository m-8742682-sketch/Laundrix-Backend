/**
 * POST /api/grace-timeout
 * 
 * Handle grace period timeouts (called by nextUserId's app)
 * 
 * Request body: { machineId: string, userId: string, timeoutType: string }
 * 
 * Timeout types:
 * - warning: 2 minutes passed → send warning notification
 * - expired: 5 minutes passed → remove user from queue, notify next
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import { rtdb } from '../lib/firebase';
import { 
  getMachine,
  getNextUser,
  removeUserFromQueue,
  updateNextUserId 
} from '../lib/queue';
import { 
  notifyGraceWarning,
  notifyRemovedFromQueue,
  notifyYourTurn,
  sendAndStoreNotification 
} from '../lib/fcm';
import type { GraceTimeoutRequest, ApiResponse, GracePeriod } from '../lib/types';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Handle CORS
  if (handleCors(req, res)) return;

  // Only allow POST
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  try {
    const { machineId, userId, timeoutType } = req.body as GraceTimeoutRequest;

    // Validate input
    if (!machineId || !userId || !timeoutType) {
      res.status(400).json({ 
        success: false, 
        error: 'Missing machineId, userId, or timeoutType' 
      });
      return;
    }

    // Get grace period data
    const gracePeriodRef = rtdb.ref(`gracePeriods/${machineId}`);
    const gracePeriodSnapshot = await gracePeriodRef.get();
    
    if (!gracePeriodSnapshot.exists()) {
      res.status(404).json({ 
        success: false, 
        error: 'No active grace period for this machine' 
      });
      return;
    }

    const gracePeriod = gracePeriodSnapshot.val() as GracePeriod;

    // Verify this is the correct user
    if (gracePeriod.userId !== userId) {
      res.status(403).json({ 
        success: false, 
        error: 'Grace period is for a different user' 
      });
      return;
    }

    // Check if grace period is still active
    if (gracePeriod.status !== 'active') {
      res.status(400).json({ 
        success: false, 
        error: `Grace period already ${gracePeriod.status}` 
      });
      return;
    }

    // Handle based on timeout type
    switch (timeoutType) {
      case 'warning':
        await handleWarning(machineId, userId, gracePeriod, gracePeriodRef);
        res.status(200).json({
          success: true,
          message: 'Warning sent. 3 minutes remaining.',
          data: { warningSent: true, minutesRemaining: 3 }
        });
        break;

      case 'expired':
        const result = await handleExpired(machineId, userId, gracePeriodRef);
        res.status(200).json({
          success: true,
          message: 'User removed from queue.',
          data: result
        });
        break;

      default:
        res.status(400).json({ 
          success: false, 
          error: 'Invalid timeoutType. Use: warning or expired' 
        });
    }

  } catch (error) {
    console.error('Grace timeout error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
}

/**
 * Handle 2-minute warning
 */
async function handleWarning(
  machineId: string, 
  userId: string,
  gracePeriod: GracePeriod,
  gracePeriodRef: any
): Promise<void> {
  // Check if warning already sent
  if (gracePeriod.warningSent) {
    console.log(`Warning already sent for ${userId} on ${machineId}`);
    return;
  }

  // Update grace period
  await gracePeriodRef.update({
    warningSent: true,
  });

  // Send warning notification
  await notifyGraceWarning(userId, machineId);
  await sendAndStoreNotification({
    userId,
    type: 'grace_warning',
    title: '⚠️ Hurry Up!',
    body: `Only 3 minutes left to claim Machine ${machineId}!`,
    data: { machineId },
    sound: 'urgent',
    priority: 'high'
  });

  console.log(`Grace period warning sent to ${userId} for ${machineId}`);
}

/**
 * Handle 5-minute expiration
 */
async function handleExpired(
  machineId: string, 
  userId: string,
  gracePeriodRef: any
): Promise<{ nextUserId: string | null; nextUserName: string | null }> {
  // Update grace period status
  await gracePeriodRef.update({
    status: 'expired',
    expiredAt: new Date().toISOString(),
  });

  // Remove user from queue
  await removeUserFromQueue(machineId, userId);

  // Notify removed user
  await notifyRemovedFromQueue(userId, machineId);
  await sendAndStoreNotification({
    userId,
    type: 'removed_from_queue',
    title: '❌ Removed from Queue',
    body: `You were removed from Machine ${machineId} queue due to timeout.`,
    data: { machineId },
    priority: 'normal'
  });

  // Update nextUserId
  await updateNextUserId(machineId);

  // Get new next user
  const nextUser = await getNextUser(machineId);
  
  if (nextUser) {
    // Start new grace period for next user
    await startNewGracePeriod(machineId, nextUser.userId, gracePeriodRef);
    
    // Notify new next user
    await notifyYourTurn(nextUser.userId, machineId);
    await sendAndStoreNotification({
      userId: nextUser.userId,
      type: 'your_turn',
      title: '🎉 Your Turn!',
      body: `Machine ${machineId} is ready for you. You have 5 minutes!`,
      data: { machineId },
      sound: 'alarm',
      priority: 'high'
    });

    console.log(`New next user ${nextUser.userId} notified for ${machineId}`);
    return { nextUserId: nextUser.userId, nextUserName: nextUser.name };
  }

  // No more users in queue, clear grace period
  await gracePeriodRef.remove();
  console.log(`Queue empty for ${machineId}, grace period cleared`);
  
  return { nextUserId: null, nextUserName: null };
}

/**
 * Start new grace period for the next user
 */
async function startNewGracePeriod(
  machineId: string, 
  userId: string,
  gracePeriodRef: any
): Promise<void> {
  const now = new Date();
  const warningAt = new Date(now.getTime() + 2 * 60 * 1000);   // +2 minutes
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);   // +5 minutes

  const gracePeriod: GracePeriod = {
    machineId,
    userId,
    startedAt: now.toISOString(),
    warningAt: warningAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    warningSent: false,
    status: 'active',
  };

  await gracePeriodRef.set(gracePeriod);
  console.log(`Started new grace period for ${userId} on ${machineId}`);
}
