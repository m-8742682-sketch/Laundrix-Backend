/**
 * POST /api/dismiss-alarm
 * 
 * Dismiss the buzzer/alarm on a machine
 * 
 * Request body: { machineId: string, userId: string }
 * 
 * Only currentUserId or nextUserId can dismiss the alarm
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getCommandsRef } from '../lib/firebase';
import { getMachine, getNextUser } from '../lib/queue';
import type { ApiResponse } from '../lib/types';

interface DismissAlarmRequest {
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
    const { machineId, userId } = req.body as DismissAlarmRequest;

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

    // Get next user
    const nextUser = await getNextUser(machineId);
    
    // Verify user is authorized to dismiss
    const isCurrentUser = machine.currentUserId === userId;
    const isNextUser = nextUser?.userId === userId;
    
    if (!isCurrentUser && !isNextUser) {
      res.status(403).json({ 
        success: false, 
        error: 'Only current or next user can dismiss the alarm' 
      });
      return;
    }

    // Send dismiss command to ESP32
    const commandsRef = getCommandsRef(machineId);
    await commandsRef.update({
      buzzer: false,
      dismissAlarm: true,
      dismissedAt: new Date().toISOString(),
      dismissedBy: userId,
    });

    console.log(`Alarm dismissed for ${machineId} by ${userId}`);

    res.status(200).json({
      success: true,
      message: 'Alarm dismissed.',
      data: { dismissed: true }
    });

  } catch (error) {
    console.error('Dismiss alarm error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
}
