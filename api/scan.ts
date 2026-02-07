/**
 * POST /api/scan
 * 
 * QR Code Scan Handler - Main entry point for all QR scans
 * 
 * Request body: { machineId: string, userId: string }
 * 
 * Logic:
 * 1. If user is currentUserId → unlock door (re-entry during session)
 * 2. If user is nextUserId → claim machine, become currentUserId
 * 3. If queue empty and machine available → claim directly
 * 4. Otherwise → unauthorized, create incident
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getCommandsRef, machinesRef, incidentsRef } from '../lib/firebase';
import { 
  getNextUser, 
  removeUserFromQueue, 
  setCurrentUser, 
  getMachine,
  getUser,
  updateNextUserId 
} from '../lib/queue';
import { 
  notifyYourTurn,
  notifySessionStarted,
  notifyUnauthorizedAlert,
  notifyUnauthorizedWarning,
  sendAndStoreNotification 
} from '../lib/fcm';
import type { ScanRequest, ApiResponse, ScanResult, Incident } from '../lib/types';

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
    const { machineId, userId } = req.body as ScanRequest;

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
        error: 'Machine not found',
        result: 'machine_not_found' as ScanResult
      });
      return;
    }

    // Get user data
    const user = await getUser(userId);
    if (!user) {
      res.status(404).json({ 
        success: false, 
        error: 'User not found',
        result: 'user_not_found' as ScanResult
      });
      return;
    }

    const currentUserId = machine.currentUserId || null;
    const nextUser = await getNextUser(machineId);
    const nextUserId = nextUser?.userId || null;

    console.log(`Scan: machineId=${machineId}, userId=${userId}, currentUserId=${currentUserId}, nextUserId=${nextUserId}`);

    // CASE 1: User is currentUserId (re-entry during their session)
    if (currentUserId === userId) {
      await unlockDoor(machineId, userId);
      
      res.status(200).json({
        success: true,
        result: 'already_current' as ScanResult,
        message: 'Door unlocked. Welcome back!',
        data: { unlocked: true }
      });
      return;
    }

    // CASE 2: User is nextUserId (claiming their turn)
    if (nextUserId === userId) {
      // Remove from queue
      await removeUserFromQueue(machineId, userId);
      
      // Set as current user
      await setCurrentUser(machineId, userId);
      
      // Unlock door
      await unlockDoor(machineId, userId);
      
      // Send notification
      await notifySessionStarted(userId, machineId);

      res.status(200).json({
        success: true,
        result: 'authorized' as ScanResult,
        message: 'Your turn! Door unlocked.',
        data: { unlocked: true }
      });
      return;
    }

    // CASE 3: No current user AND queue is empty → direct claim
    if (!currentUserId && !nextUserId) {
      // Set as current user directly
      await setCurrentUser(machineId, userId);
      
      // Unlock door
      await unlockDoor(machineId, userId);
      
      // Send notification
      await notifySessionStarted(userId, machineId);

      res.status(200).json({
        success: true,
        result: 'queue_empty_claim' as ScanResult,
        message: 'Machine is yours! Door unlocked.',
        data: { unlocked: true }
      });
      return;
    }

    // CASE 4: Unauthorized access attempt
    // Someone is trying to use machine when it's not their turn
    const incidentId = await createIncident(machineId, userId, user, nextUserId!, nextUser!);
    
    // Notify the intruder
    await notifyUnauthorizedWarning(userId, machineId);
    
    // Notify the rightful next user
    if (nextUserId) {
      await notifyUnauthorizedAlert(
        nextUserId, 
        machineId, 
        incidentId,
        user.displayName || user.name || 'Someone'
      );
    }

    // Store notifications
    await sendAndStoreNotification({
      userId: userId,
      type: 'unauthorized_warning',
      title: '⚠️ Not Your Turn!',
      body: `Machine ${machineId} is not available for you.`,
      data: { machineId }
    });

    res.status(403).json({
      success: false,
      result: 'unauthorized' as ScanResult,
      message: 'Not your turn. The rightful user has been notified.',
      data: { 
        incidentId,
        currentUserId,
        nextUserId,
        expiresIn: 60  // seconds until auto-timeout
      }
    });

  } catch (error) {
    console.error('Scan error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
}

/**
 * Send unlock command to ESP32 via RTDB
 */
async function unlockDoor(machineId: string, userId: string): Promise<void> {
  const commandsRef = getCommandsRef(machineId);
  await commandsRef.update({
    unlock: true,
    requestUserId: userId,
    unlockAt: new Date().toISOString(),
  });
  console.log(`Unlock command sent for ${machineId}`);
}

/**
 * Create incident record for unauthorized access
 */
async function createIncident(
  machineId: string,
  intruderId: string,
  intruderData: Record<string, any>,
  nextUserId: string,
  nextUserData: Record<string, any>
): Promise<string> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 1000); // +60 seconds

  const incident: Incident = {
    machineId,
    intruderId,
    intruderName: intruderData.displayName || intruderData.name || 'Unknown',
    nextUserId,
    nextUserName: nextUserData.name || 'Unknown',
    status: 'pending',
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    resolvedAt: null,
    buzzerTriggered: false,
  };

  const docRef = await incidentsRef.add(incident);
  console.log(`Created incident ${docRef.id} for machine ${machineId}`);
  return docRef.id;
}
