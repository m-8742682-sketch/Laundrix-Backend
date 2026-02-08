/**
 * POST /api/incident-action
 * 
 * Handle incident responses from users
 * 
 * Request body: { incidentId: string, userId: string, action: string }
 * 
 * Actions:
 * - confirm_not_me: nextUserId confirms it wasn't them → trigger buzzer
 * - dismiss: nextUserId says "that's me" → dismiss incident
 * - timeout: 60 seconds passed, no response → trigger buzzer
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import { incidentsRef, getCommandsRef } from '../lib/firebase';
import { 
  notifyBuzzerTriggered,
  sendAndStoreNotification 
} from '../lib/fcm';
import type { IncidentActionRequest, ApiResponse, Incident } from '../lib/types';

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
    const { incidentId, userId, action } = req.body as IncidentActionRequest;

    // Validate input
    if (!incidentId || !userId || !action) {
      res.status(400).json({ 
        success: false, 
        error: 'Missing incidentId, userId, or action' 
      });
      return;
    }

    // Get incident
    const incidentDoc = await incidentsRef.doc(incidentId).get();
    if (!incidentDoc.exists) {
      res.status(404).json({ 
        success: false, 
        error: 'Incident not found' 
      });
      return;
    }

    const incident = incidentDoc.data() as Incident;

    // Check if incident is still pending
    if (incident.status !== 'pending') {
      res.status(400).json({ 
        success: false, 
        error: `Incident already ${incident.status}`,
        data: { status: incident.status }
      });
      return;
    }

    // Handle based on action
    switch (action) {
      case 'confirm_not_me':
        await handleConfirmNotMe(incidentId, incident, userId);
        res.status(200).json({
          success: true,
          message: 'Confirmed. Buzzer activated.',
          data: { status: 'confirmed', buzzerTriggered: true }
        });
        break;

      case 'dismiss':
        await handleDismiss(incidentId, incident, userId);
        res.status(200).json({
          success: true,
          message: 'Incident dismissed.',
          data: { status: 'dismissed', buzzerTriggered: false }
        });
        break;

      case 'timeout':
        await handleTimeout(incidentId, incident);
        res.status(200).json({
          success: true,
          message: 'Timeout. Buzzer activated.',
          data: { status: 'timeout', buzzerTriggered: true }
        });
        break;

      default:
        res.status(400).json({ 
          success: false, 
          error: 'Invalid action. Use: confirm_not_me, dismiss, or timeout' 
        });
    }

  } catch (error) {
    console.error('Incident action error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
}

/**
 * Handle "Not Me" confirmation from nextUserId
 */
async function handleConfirmNotMe(
  incidentId: string, 
  incident: Incident, 
  userId: string
): Promise<void> {
  // Verify it's the nextUserId responding
  if (userId !== incident.nextUserId) {
    throw new Error('Only the rightful next user can confirm');
  }

  // Update incident status
  await incidentsRef.doc(incidentId).update({
    status: 'confirmed',
    resolvedAt: new Date().toISOString(),
    buzzerTriggered: true,
  });

  // Trigger buzzer on ESP32
  await triggerBuzzer(incident.machineId, true);

  // Notify the intruder
  await sendAndStoreNotification({
    userId: incident.intruderId,
    type: 'buzzer_triggered',
    title: '🚨 Access Denied',
    body: `You were reported for unauthorized use of Machine ${incident.machineId}.`,
    data: { machineId: incident.machineId, incidentId },
    priority: 'high'
  });

  // Notify the rightful user
  await sendAndStoreNotification({
    userId: incident.nextUserId,
    type: 'buzzer_triggered',
    title: '✅ Alert Triggered',
    body: `Buzzer activated for Machine ${incident.machineId}. The intruder has been warned.`,
    data: { machineId: incident.machineId, incidentId }
  });

  console.log(`Incident ${incidentId}: Confirmed not me, buzzer triggered`);
}

/**
 * Handle dismiss (false alarm - it was actually them)
 */
async function handleDismiss(
  incidentId: string, 
  incident: Incident, 
  userId: string
): Promise<void> {
  // Verify it's the nextUserId responding
  if (userId !== incident.nextUserId) {
    throw new Error('Only the rightful next user can dismiss');
  }

  // Update incident status
  await incidentsRef.doc(incidentId).update({
    status: 'dismissed',
    resolvedAt: new Date().toISOString(),
    buzzerTriggered: false,
  });

  console.log(`Incident ${incidentId}: Dismissed (false alarm)`);
}

/**
 * Handle 60-second timeout (no response)
 */
async function handleTimeout(incidentId: string, incident: Incident): Promise<void> {
  // Verify incident has actually expired
  const now = new Date();
  const expiresAt = new Date(incident.expiresAt);
  
  if (now < expiresAt) {
    // Not actually expired yet, but we'll allow it if close (within 5 seconds)
    const timeDiff = expiresAt.getTime() - now.getTime();
    if (timeDiff > 5000) {
      throw new Error('Incident has not expired yet');
    }
  }

  // Update incident status
  await incidentsRef.doc(incidentId).update({
    status: 'timeout',
    resolvedAt: new Date().toISOString(),
    buzzerTriggered: true,
  });

  // Trigger buzzer on ESP32
  await triggerBuzzer(incident.machineId, true);

  // Notify both users
  await sendAndStoreNotification({
    userId: incident.intruderId,
    type: 'buzzer_triggered',
    title: '🚨 Alert Triggered',
    body: `Unauthorized access alert for Machine ${incident.machineId}.`,
    data: { machineId: incident.machineId, incidentId },
    priority: 'high'
  });

  await sendAndStoreNotification({
    userId: incident.nextUserId,
    type: 'buzzer_triggered',
    title: '🚨 Auto-Alert Triggered',
    body: `No response received. Buzzer activated for Machine ${incident.machineId}.`,
    data: { machineId: incident.machineId, incidentId }
  });

  console.log(`Incident ${incidentId}: Timeout, buzzer triggered`);
}

/**
 * Send buzzer command to ESP32 via RTDB
 */
async function triggerBuzzer(machineId: string, activate: boolean): Promise<void> {
  const commandsRef = getCommandsRef(machineId);
  await commandsRef.update({
    buzzer: activate,
    buzzerAt: new Date().toISOString(),
  });
  console.log(`Buzzer ${activate ? 'activated' : 'deactivated'} for ${machineId}`);
}
