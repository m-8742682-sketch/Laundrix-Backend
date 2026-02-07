/**
 * POST /api/leave-queue
 * 
 * Leave the queue for a machine
 * 
 * Request body: { machineId: string, userId: string }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { 
  getMachine,
  removeUserFromQueue,
  isUserInQueue,
  updateNextUserId,
  getNextUser
} from '../lib/queue';
import { rtdb } from '../lib/firebase';
import { notifyYourTurn, sendAndStoreNotification } from '../lib/fcm';
import type { ApiResponse } from '../lib/types';

interface LeaveQueueRequest {
  machineId: string;
  userId: string;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Only allow POST
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  try {
    const { machineId, userId } = req.body as LeaveQueueRequest;

    // Validate input
    if (!machineId || !userId) {
      res.status(400).json({ 
        success: false, 
        error: 'Missing machineId or userId' 
      });
      return;
    }

    // Get machine data
    const machine = await getMachine(machineId);
    if (!machine) {
      res.status(404).json({ 
        success: false, 
        error: 'Machine not found' 
      });
      return;
    }

    // Check if in queue
    if (!(await isUserInQueue(machineId, userId))) {
      res.status(400).json({ 
        success: false, 
        error: 'Not in queue for this machine' 
      });
      return;
    }

    // Check if this user was the next user (position 1)
    const wasNextUser = machine.nextUserId === userId;

    // Remove from queue
    const removed = await removeUserFromQueue(machineId, userId);

    if (!removed) {
      res.status(500).json({ 
        success: false, 
        error: 'Failed to remove from queue' 
      });
      return;
    }

    // Update nextUserId
    await updateNextUserId(machineId);

    // If this was the next user and there's a grace period, clear it
    if (wasNextUser) {
      const gracePeriodRef = rtdb.ref(`gracePeriods/${machineId}`);
      const gracePeriodSnapshot = await gracePeriodRef.get();
      
      if (gracePeriodSnapshot.exists()) {
        const gracePeriod = gracePeriodSnapshot.val();
        if (gracePeriod.userId === userId) {
          // Clear old grace period
          await gracePeriodRef.remove();
          
          // Get new next user and notify them
          const newNextUser = await getNextUser(machineId);
          if (newNextUser && !machine.currentUserId) {
            // Start new grace period
            const now = new Date();
            await gracePeriodRef.set({
              machineId,
              userId: newNextUser.userId,
              startedAt: now.toISOString(),
              warningAt: new Date(now.getTime() + 2 * 60 * 1000).toISOString(),
              expiresAt: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
              warningSent: false,
              status: 'active',
            });

            // Notify new next user
            await notifyYourTurn(newNextUser.userId, machineId);
            await sendAndStoreNotification({
              userId: newNextUser.userId,
              type: 'your_turn',
              title: '🎉 Your Turn!',
              body: `Machine ${machineId} is ready for you. You have 5 minutes!`,
              data: { machineId },
              sound: 'alarm',
              priority: 'high'
            });
          }
        }
      }
    }

    console.log(`User ${userId} left queue for ${machineId}`);

    res.status(200).json({
      success: true,
      message: 'Left queue successfully',
      data: { removed: true }
    });

  } catch (error) {
    console.error('Leave queue error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
}
