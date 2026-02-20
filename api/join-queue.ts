/**
 * POST /api/join-queue
 * 
 * Join the queue for a machine
 * 
 * Request body: { machineId: string, userId: string, userName: string, idempotencyKey?: string }
 * 
 * OPTIMIZATIONS:
 * - Parallel database reads where possible
 * - Reduced sequential awaits
 * - Faster response times
 * - IDEMPOTENCY KEY: Prevents duplicate joins from race conditions
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import { 
  getMachine,
  getUser,
  addUserToQueue,
  isUserInQueue,
  updateNextUserId 
} from '../lib/queue';
import { sendAndStoreNotification } from '../lib/fcm';

interface JoinQueueRequest {
  machineId: string;
  userId: string;
  userName: string;
  idempotencyKey?: string;  // NEW: For preventing duplicate joins
}

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
    const { machineId, userId, userName, idempotencyKey } = req.body as JoinQueueRequest;

    if (!machineId || !userId) {
      res.status(400).json({ success: false, error: 'Missing machineId or userId' });
      return;
    }

    const [machine, user, userInQueue] = await Promise.all([
      getMachine(machineId),
      getUser(userId),
      isUserInQueue(machineId, userId)
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
        code: 'ALREADY_IN_QUEUE'
      });
      return;
    }

    if (machine.currentUserId === userId) {
      res.status(400).json({ 
        success: false, 
        error: 'You are currently using this machine',
        code: 'ALREADY_CURRENT_USER'
      });
      return;
    }

    // PASS idempotencyKey
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

    // Background tasks - FIX: Properly structure the notification call
    Promise.all([
      updateNextUserId(machineId),
      sendAndStoreNotification({
        userId,
        type: 'queue_joined',
        title: '✅ Joined Queue',
        body: `You are #${queueUser.position} in line for Machine ${machineId}.`,
        data: { machineId, position: queueUser.position.toString() }
      })
    ]).catch(err => console.error('Background task error:', err));

    console.log(`User ${userId} joined queue for ${machineId} at position ${queueUser.position}`);

    res.status(200).json({
      success: true,
      message: `Joined queue at position ${queueUser.position}`,
      data: {
        position: queueUser.position,
        queueToken: queueUser.queueToken,
        joinedAt: queueUser.joinedAt,
      }
    });

  } catch (error) {
    console.error('Join queue error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}