/**
 * POST /api/leave-queue
 * 
 * Leave the queue for a machine
 * 
 * Request body: { machineId: string, userId: string }
 * 
 * OPTIMIZATIONS:
 * - Parallel operations where possible
 * - Immediate response with background tasks
 * - Faster performance
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import { 
  removeUserFromQueue,
  updateNextUserId,
  isUserInQueue 
} from '../lib/queue';
import { sendAndStoreNotification } from '../lib/fcm';

interface LeaveQueueRequest {
  machineId: string;
  userId: string;
}

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
    const { machineId, userId } = req.body as LeaveQueueRequest;

    // Validate input
    if (!machineId || !userId) {
      res.status(400).json({ 
        success: false, 
        error: 'Missing machineId or userId' 
      });
      return;
    }

    // Check if user is in queue
    const userInQueue = await isUserInQueue(machineId, userId);
    if (!userInQueue) {
      res.status(400).json({ 
        success: false, 
        error: 'Not in queue for this machine' 
      });
      return;
    }

    // Remove from queue
    const removed = await removeUserFromQueue(machineId, userId);
    
    if (!removed) {
      res.status(500).json({ 
        success: false, 
        error: 'Failed to leave queue' 
      });
      return;
    }

    // OPTIMIZATION: Run background tasks in parallel without waiting
    Promise.all([
      updateNextUserId(machineId),
      sendAndStoreNotification({
        userId,
        type: 'queue_left', // Use correct type from fcm.ts
        title: '👋 Left Queue',
        body: `You've left the queue for Machine ${machineId}.`,
        data: { machineId }
      })
    ]).catch(err => {
      console.error('Background task error:', err);
    });

    console.log(`User ${userId} left queue for ${machineId}`);

    // Send response immediately
    res.status(200).json({
      success: true,
      message: 'Successfully left the queue'
    });

  } catch (error) {
    console.error('Leave queue error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
}