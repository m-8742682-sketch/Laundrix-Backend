/**
 * POST /api/incident-action — Staged incident flow
 *
 * Status flow:
 *   pre_pending   → incident created, waiting for intruder to confirm
 *   owner_pending → intruder confirmed; only owner + intruder see modals
 *   admin_pending → owner reported intruder; admin sees buzzer modal
 *   resolved      → owner said "Yes It's Me" (Interrupted, no buzzer)
 *   dismissed     → admin closed the buzzer
 *   timeout       → 60s no owner response → Unauthorized history
 *
 * Notifications:
 *   confirm        → only intruder ("Machine in use") + owner ("Someone at your machine")
 *   thats_me       → silent, history = Interrupted
 *   confirm_not_me → admins + intruder ("Unauthorized Access Alert"), history = Unauthorized
 *   timeout        → admins notified, history = Unauthorized
 *   admin_dismiss  → stops buzzer
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import { incidentsRef, getIotRef, db, rtdb } from '../lib/firebase';
import { sendAndStoreNotification } from '../lib/fcm';
import type { IncidentActionRequest, Incident } from '../lib/types';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  try {
    const { incidentId, userId, action, cancelReason } = req.body as IncidentActionRequest & { cancelReason?: string };
    if (!incidentId || !userId || !action) {
      res.status(400).json({ success: false, error: 'Missing incidentId, userId, or action' });
      return;
    }

    const incidentDoc = await incidentsRef.doc(incidentId).get();
    if (!incidentDoc.exists) {
      res.status(404).json({ success: false, error: 'Incident not found' });
      return;
    }
    const incident = { id: incidentId, ...incidentDoc.data() } as any;

    const terminal = ['resolved', 'dismissed', 'timeout'];
    if (terminal.includes(incident.status)) {
      res.status(400).json({ success: false, error: `Incident already ${incident.status}`, data: { status: incident.status } });
      return;
    }

    switch (action) {
      case 'confirm':
        await handleConfirm(incidentId, incident, userId);
        res.status(200).json({ success: true, message: 'Owner notified.', data: { status: 'owner_pending' } });
        break;

      case 'thats_me':
      case 'dismiss':
        await handleThatsMe(incidentId, incident, userId, cancelReason);
        res.status(200).json({ success: true, message: 'Dismissed. History = Interrupted.', data: { status: 'resolved' } });
        break;

      case 'confirm_not_me':
        await handleReportIntruder(incidentId, incident, userId);
        res.status(200).json({ success: true, message: 'Reported. Admins notified.', data: { status: 'admin_pending', buzzerTriggered: true } });
        break;

      case 'admin_dismiss':
        await handleAdminDismiss(incidentId, incident, true);
        res.status(200).json({ success: true, message: 'Buzzer dismissed.', data: { status: 'dismissed' } });
        break;

      case 'admin_dismiss_false':
        await handleAdminDismiss(incidentId, incident, false);
        res.status(200).json({ success: true, message: 'False alarm dismissed.', data: { status: 'dismissed' } });
        break;

      case 'timeout':
        await handleTimeout(incidentId, incident);
        res.status(200).json({ success: true, message: 'Timeout processed.', data: { status: 'timeout' } });
        break;

      default:
        res.status(400).json({ success: false, error: 'Invalid action' });
    }
  } catch (error: any) {
    console.error('Incident action error:', error);
    res.status(500).json({ success: false, error: error?.message || 'Internal server error' });
  }
}

function getOwnerUserId(incident: any): string {
  return incident.ownerUserId || incident.nextUserId;
}

// Step 1: intruder confirmed → owner_pending
// Writes RTDB userIncident/{ownerUserId} so owner's device picks it up instantly
// (Firestore security rules may block list queries by ownerUserId field)
async function handleConfirm(incidentId: string, incident: any, userId: string): Promise<void> {
  const ownerUserId = getOwnerUserId(incident);
  const now = new Date().toISOString();
  const newExpiresAt = new Date(Date.now() + 60 * 1000).toISOString();

  // Update Firestore status
  await incidentsRef.doc(incidentId).update({
    status: 'owner_pending',
    confirmedAt: now,
    confirmedBy: userId,
    expiresAt: newExpiresAt,
  });

  // ── KEY FIX: write RTDB signal directly to owner's node ──────────────────
  // Firestore query-by-field may be blocked by security rules for the owner.
  // RTDB userIncident/{uid} is readable by that user only — reliable delivery.
  await rtdb.ref(`userIncident/${ownerUserId}`).set({
    incidentId,
    machineId:     incident.machineId,
    intruderName:  incident.intruderName,
    intruderId:    incident.intruderId,
    ownerUserId,
    ownerUserName: incident.ownerUserName || incident.nextUserName || 'Unknown',
    createdAt:     incident.createdAt,
    expiresAt:     newExpiresAt,
    status:        'owner_pending',
  });

  await Promise.allSettled([
    sendAndStoreNotification({
      userId: incident.intruderId,
      type: 'unauthorized_warning',
      title: '⚠️ Machine In Use',
      body: `Machine ${incident.machineId} is in use. Your access has been reported to the owner.`,
      data: { machineId: incident.machineId, incidentId, type: 'incident_intruder' },
      priority: 'high',
    }),
    sendAndStoreNotification({
      userId: ownerUserId,
      type: 'unauthorized_alert',
      title: '🚨 Someone Is Using Your Machine!',
      body: `${incident.intruderName} is using Machine ${incident.machineId}. Tap to respond.`,
      data: { machineId: incident.machineId, incidentId, type: 'incident_owner' },
      priority: 'high',
    }),
  ]);
}

// Step 2a: owner "Yes It's Me" → resolved, history = Interrupted
async function handleThatsMe(incidentId: string, incident: any, userId: string, cancelReason?: string): Promise<void> {
  const ownerUserId = getOwnerUserId(incident);
  await incidentsRef.doc(incidentId).update({
    status: 'resolved',
    resolvedAt: new Date().toISOString(),
    resolvedBy: userId,
    buzzerTriggered: false,
    ...(cancelReason ? { cancelReason } : {}),
  });
  // Clear RTDB signal
  await rtdb.ref(`userIncident/${ownerUserId}`).remove().catch(() => {});
  await updateOrCreateHistory(incident, 'Interrupted');
}

// Step 2b: owner "Report Intruder" → admin_pending, buzzer, history = Unauthorized
async function handleReportIntruder(incidentId: string, incident: any, userId: string): Promise<void> {
  const ownerUserId = getOwnerUserId(incident);
  if (userId !== ownerUserId) throw new Error('Only the rightful owner can report');

  const now = new Date().toISOString();
  const adminExpiresAt = new Date(Date.now() + 60 * 1000).toISOString();

  await incidentsRef.doc(incidentId).update({
    status: 'admin_pending',
    reportedAt: now,
    reportedBy: userId,
    expiresAt: adminExpiresAt,
    buzzerTriggered: true,
  });

  await triggerBuzzer(incident.machineId, true);
  await updateOrCreateHistory(incident, 'Unauthorized');
  // Clear owner RTDB signal (owner already acted)
  await rtdb.ref(`userIncident/${ownerUserId}`).remove().catch(() => {});

  await Promise.allSettled([
    sendAndStoreNotification({
      userId: incident.intruderId,
      type: 'buzzer_triggered',
      title: '🚨 Unauthorized Access Alert',
      body: `You have been reported for unauthorized use of Machine ${incident.machineId}.`,
      data: { machineId: incident.machineId, incidentId },
      priority: 'high',
    }),
    notifyAdmins(
      incident.machineId, incidentId,
      '🚨 Unauthorized Access Alert',
      `${incident.intruderName} reported by ${incident.ownerUserName || 'owner'} on Machine ${incident.machineId}. Please dismiss the buzzer.`,
      incident.intruderId
    ),
  ]);
}

// Step 3: admin dismisses
async function handleAdminDismiss(incidentId: string, incident: any, stopBuzzer: boolean): Promise<void> {
  await incidentsRef.doc(incidentId).update({
    status: 'dismissed',
    resolvedAt: new Date().toISOString(),
    buzzerTriggered: false,
  });
  if (stopBuzzer) await triggerBuzzer(incident.machineId, false);
}

// Timeout: owner never responded → Unauthorized
async function handleTimeout(incidentId: string, incident: any): Promise<void> {
  const now = new Date().toISOString();
  await incidentsRef.doc(incidentId).update({
    status: 'timeout',
    resolvedAt: now,
    buzzerTriggered: false,
  });

  if (incident.status === 'owner_pending') {
    const ownerUserId = getOwnerUserId(incident);
    await updateOrCreateHistory(incident, 'Unauthorized');
    // Clear RTDB signal
    await rtdb.ref(`userIncident/${ownerUserId}`).remove().catch(() => {});
    await notifyAdmins(
      incident.machineId, incidentId,
      '🚨 Unauthorized Use — No Response',
      `No response for Machine ${incident.machineId}. ${incident.intruderName} used the machine without authorization.`
    );
  }
}

async function triggerBuzzer(machineId: string, activate: boolean): Promise<void> {
  try { await getIotRef(machineId).update({ buzzerState: activate }); } catch {}
}

async function notifyAdmins(machineId: string, incidentId: string, title: string, body: string, excludeUserId?: string): Promise<void> {
  try {
    const adminsSnap = await incidentsRef.firestore.collection('users').where('role', '==', 'admin').get();
    await Promise.all(
      adminsSnap.docs
        .filter(doc => doc.id !== excludeUserId)
        .map(doc => sendAndStoreNotification({
          userId: doc.id, type: 'unauthorized_alert', title, body,
          data: { machineId, incidentId }, priority: 'high',
        }))
    );
  } catch (err) { console.error('[notifyAdmins] failed:', err); }
}

async function updateOrCreateHistory(incident: any, status: 'Interrupted' | 'Unauthorized'): Promise<void> {
  try {
    const now = new Date().toISOString();
    // Try updating existing record first (written by QRScanViewModel)
    const snap = await db.collection('usageHistory')
      .where('incidentId', '==', incident.id)
      .limit(1).get();

    if (!snap.empty) {
      await snap.docs[0].ref.update({ resultStatus: status, updatedAt: now });
    } else {
      await db.collection('usageHistory').add({
        userId: incident.intruderId,
        userName: incident.intruderName,
        machineId: incident.machineId,
        startTime: incident.confirmedAt || incident.createdAt || now,
        endTime: now,
        duration: 0,
        resultStatus: status,
        incidentId: incident.id,
        createdAt: now,
      });
    }
  } catch (err) { console.error('[updateOrCreateHistory] failed:', err); }
}
