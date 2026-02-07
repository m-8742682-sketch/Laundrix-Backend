/**
 * POST /api/join-queue
 * 
 * Join the queue for a machine
 * 
 * Request body: { machineId: string, userId: string }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { 
  getMachine,
  getUser,
  addUserToQueue,
  isUserInQueue,
  updateNextUserId 
} from '../lib/queue';
import { sendAndStoreNotification } from '../lib/fcm';
import type { ApiResponse } from '../lib/types';

interface JoinQueueRequest {
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
    const { machineId, userId } = req.body as JoinQueueRequest;

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

    // Get user data
    const user = await getUser(userId);
    if (!user) {
      res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
      return;
    }

    // Check if already in queue
    if (await isUserInQueue(machineId, userId)) {
      res.status(400).json({ 
        success: false, 
        error: 'Already in queue for this machine' 
      });
      return;
    }

    // Check if user is current user
    if (machine.currentUserId === userId) {
      res.status(400).json({ 
        success: false, 
        error: 'You are currently using this machine' 
      });
      return;
    }

    // Add to queue
    const queueUser = await addUserToQueue(
      machineId,
      userId,
      user.displayName || user.name || 'Unknown',
      user.photoURL || user.avatar || null
    );

    if (!queueUser) {
      res.status(500).json({ 
        success: false, 
        error: 'Failed to add to queue' 
      });
      return;
    }

    // Update nextUserId if this is first in queue
    await updateNextUserId(machineId);

    // Send confirmation notification
    await sendAndStoreNotification({
      userId,
      type: 'session_started', // Reusing type, could create 'queue_joined'
      title: '✅ Joined Queue',
      body: `You are #${queueUser.position} in line for Machine ${machineId}.`,
      data: { machineId, position: queueUser.position.toString() }
    });

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
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
}
