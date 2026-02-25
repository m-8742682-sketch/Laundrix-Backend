/**
 * POST /api/incident-action  — FIXED VERSION
 *
 * FIX #6: Notify all admins on incident confirmation/timeout
 *         Allow ownerUserId (currentUserId or nextUserId) to act
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import { incidentsRef, getCommandsRef } from '../lib/firebase';
import { notifyBuzzerTriggered, sendAndStoreNotification } from '../lib/fcm';
import type { IncidentActionRequest, ApiResponse, Incident } from '../lib/types';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  try {
    const { incidentId, userId, action } = req.body as IncidentActionRequest;
    if (!incidentId || !userId || !action) {
      res.status(400).json({ success: false, error: 'Missing incidentId, userId, or action' });
      return;
    }

    const incidentDoc = await incidentsRef.doc(incidentId).get();
    if (!incidentDoc.exists) {
      res.status(404).json({ success: false, error: 'Incident not found' });
      return;
    }
    const incident = incidentDoc.data() as Incident;

    if (incident.status !== 'pending') {
      res.status(400).json({ success: false, error: `Incident already ${incident.status}`, data: { status: incident.status } });
      return;
    }

    switch (action) {
      case 'confirm_not_me':
        await handleConfirmNotMe(incidentId, incident, userId);
        res.status(200).json({ success: true, message: 'Confirmed. Buzzer activated.', data: { status: 'confirmed', buzzerTriggered: true } });
        break;

      case 'dismiss':
        await handleDismiss(incidentId, incident, userId);
        res.status(200).json({ success: true, message: 'Incident dismissed.', data: { status: 'dismissed', buzzerTriggered: false } });
        break;

      case 'timeout':
        await handleTimeout(incidentId, incident);
        res.status(200).json({ success: true, message: 'Timeout. Buzzer activated.', data: { status: 'timeout', buzzerTriggered: true } });
        break;

      default:
        res.status(400).json({ success: false, error: 'Invalid action' });
    }
  } catch (error: any) {
    console.error('Incident action error:', error);
    res.status(500).json({ success: false, error: error?.message || 'Internal server error' });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getOwnerUserId(incident: Incident): string {
  // FIX #6: support ownerUserId field; fall back to nextUserId for backward compat
  return (incident as any).ownerUserId || incident.nextUserId;
}

async function handleConfirmNotMe(incidentId: string, incident: Incident, userId: string): Promise<void> {
  const ownerUserId = getOwnerUserId(incident);
  if (userId !== ownerUserId) throw new Error('Only the rightful owner can confirm');

  await incidentsRef.doc(incidentId).update({
    status: 'confirmed',
    resolvedAt: new Date().toISOString(),
    buzzerTriggered: true,
  });

  await triggerBuzzer(incident.machineId, true);

  // Notify intruder, owner, and all admins
  await Promise.all([
    sendAndStoreNotification({
      userId: incident.intruderId,
      type: 'buzzer_triggered',
      title: '🚨 Access Denied',
      body: `You were reported for unauthorized use of Machine ${incident.machineId}.`,
      data: { machineId: incident.machineId, incidentId },
      priority: 'high',
    }),
    sendAndStoreNotification({
      userId: ownerUserId,
      type: 'buzzer_triggered',
      title: '✅ Alert Triggered',
      body: `Buzzer activated for Machine ${incident.machineId}. The intruder has been warned.`,
      data: { machineId: incident.machineId, incidentId },
    }),
    notifyAdmins(incident.machineId, incidentId, '🚨 Unauthorized Access Confirmed',
      `${incident.intruderName} was confirmed unauthorized on Machine ${incident.machineId}.`, incident.intruderId),
  ]);
}

async function handleDismiss(incidentId: string, incident: Incident, userId: string): Promise<void> {
  const ownerUserId = getOwnerUserId(incident);
  // FIX #6: allow the owner OR the intruder (if they tapped "That's Me") to dismiss
  if (userId !== ownerUserId && userId !== incident.intruderId) {
    throw new Error('Only the rightful owner or the scanner can dismiss');
  }

  await incidentsRef.doc(incidentId).update({
    status: 'dismissed',
    resolvedAt: new Date().toISOString(),
    buzzerTriggered: false,
  });
}

async function handleTimeout(incidentId: string, incident: Incident): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(incident.expiresAt);
  if (now < expiresAt) {
    const timeDiff = expiresAt.getTime() - now.getTime();
    if (timeDiff > 5000) throw new Error('Incident has not expired yet');
  }

  const ownerUserId = getOwnerUserId(incident);

  await incidentsRef.doc(incidentId).update({
    status: 'timeout',
    resolvedAt: new Date().toISOString(),
    buzzerTriggered: true,
  });

  await triggerBuzzer(incident.machineId, true);

  await Promise.all([
    sendAndStoreNotification({
      userId: incident.intruderId,
      type: 'buzzer_triggered',
      title: '🚨 Alert Triggered',
      body: `Unauthorized access alert for Machine ${incident.machineId}.`,
      data: { machineId: incident.machineId, incidentId },
      priority: 'high',
    }),
    sendAndStoreNotification({
      userId: ownerUserId,
      type: 'buzzer_triggered',
      title: '🚨 Auto-Alert Triggered',
      body: `No response. Buzzer activated for Machine ${incident.machineId}.`,
      data: { machineId: incident.machineId, incidentId },
    }),
    // FIX #6: notify admins on timeout too
    notifyAdmins(incident.machineId, incidentId, '🚨 Unauthorized Use — Timeout',
      `No response to incident on Machine ${incident.machineId}. Buzzer triggered.`),
  ]);
}

async function triggerBuzzer(machineId: string, activate: boolean): Promise<void> {
  const commandsRef = getCommandsRef(machineId);
  await commandsRef.update({ buzzer: activate, buzzerAt: new Date().toISOString() });
}

async function notifyAdmins(
  machineId: string,
  incidentId: string,
  title: string,
  body: string,
  excludeUserId?: string
): Promise<void> {
  try {
    const adminsSnap = await incidentsRef.firestore
      .collection('users')
      .where('role', '==', 'admin')
      .get();

    await Promise.all(
      adminsSnap.docs
        .filter(doc => doc.id !== excludeUserId)
        .map(doc =>
          sendAndStoreNotification({
            userId: doc.id,
            type: 'unauthorized_alert',
            title,
            body,
            data: { machineId, incidentId },
            priority: 'high',
          })
        )
    );
  } catch (err) {
    console.error('[notifyAdmins] failed:', err);
  }
}
