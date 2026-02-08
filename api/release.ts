/**
 * POST /api/release
 * 
 * Release Machine Handler - End current user's session
 * 
 * Request body: { machineId: string, userId: string }
 * 
 * Logic:
 * 1. Verify user is currentUserId
 * 2. Clear currentUserId
 * 3. Unlock door (stays unlocked for next user)
 * 4. Notify nextUserId (starts 5-min grace period)
 * 5. Update machine status to Available
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import { getCommandsRef, rtdb } from '../lib/firebase';
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
  // Handle CORS
  if (handleCors(req, res)) return;

  // Only allow POST
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  try {
    const { machineId, userId } = req.body as ReleaseRequest;

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

    // Verify user is current user
    if (machine.currentUserId !== userId) {
      res.status(403).json({ 
        success: false, 
        error: 'You are not the current user of this machine' 
      });
      return;
    }

    // Clear current user
    await setCurrentUser(machineId, null);

    // Unlock door (stays closed but unlocked)
    await unlockDoor(machineId);

    // Notify previous user (session ended)
    await notifySessionEnded(userId, machineId);
    await sendAndStoreNotification({
      userId,
      type: 'session_ended',
      title: '👋 Session Ended',
      body: `Your session at Machine ${machineId} has ended.`,
      data: { machineId }
    });

    // Check if there's a next user
    const nextUser = await getNextUser(machineId);
    
    if (nextUser) {
      // Start grace period for next user
      await startGracePeriod(machineId, nextUser.userId);
      
      // Notify next user with alarm sound
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

      res.status(200).json({
        success: true,
        message: 'Session ended. Next user has been notified.',
        data: {
          released: true,
          nextUserId: nextUser.userId,
          nextUserName: nextUser.name,
          gracePeriodMinutes: 5
        }
      });
    } else {
      // No one in queue
      res.status(200).json({
        success: true,
        message: 'Session ended. Machine is now available.',
        data: {
          released: true,
          nextUserId: null,
          status: 'Available'
        }
      });
    }

  } catch (error) {
    console.error('Release error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
}

/**
 * Send unlock command to ESP32 via RTDB
 */
async function unlockDoor(machineId: string): Promise<void> {
  const commandsRef = getCommandsRef(machineId);
  await commandsRef.update({
    unlock: true,
    release: true,
    unlockAt: new Date().toISOString(),
  });
  console.log(`Release + unlock command sent for ${machineId}`);
}

/**
 * Start grace period tracking in RTDB
 * The app will manage the countdown and call grace-timeout endpoint
 */
async function startGracePeriod(machineId: string, userId: string): Promise<void> {
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

  // Store in RTDB for real-time tracking
  await rtdb.ref(`gracePeriods/${machineId}`).set(gracePeriod);
  console.log(`Started grace period for ${userId} on ${machineId}`);
}
