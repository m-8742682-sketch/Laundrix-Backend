/**
 * GET /api/cron
 *
 * Server-side cron — runs every minute via Vercel Cron.
 * This is the ONLY place that expires grace periods and removes users from queue.
 * Clients do NOT call grace-timeout for "expired" — only the cron does.
 *
 * Tasks:
 *   1. Grace period expiry  — removes users who didn't scan within 5 min (ONCE per expiry)
 *   2. Incident timeout     — triggers buzzer if no admin response in 60s
 *
 * Protected by CRON_SECRET_KEY env var.
 * vercel.json schedule: "* * * * *"
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { rtdb, incidentsRef, getCommandsRef } from '../lib/firebase';
import { getNextUser, removeUserFromQueue, updateNextUserId } from '../lib/queue';
import { notifyYourTurn, sendAndStoreNotification } from '../lib/fcm';
import { startGracePeriod, expireGracePeriod } from '../lib/grace';
import type { GracePeriod, Incident } from '../lib/types';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (secret !== process.env.CRON_SECRET_KEY) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const results = {
    gracePeriods: { processed: [] as string[], errors: [] as string[] },
    incidents:    { processed: [] as string[], errors: [] as string[] },
  };

  // ─────────────────────────────────────────────
  // TASK 1: Grace Period Expiry
  // ─────────────────────────────────────────────
  try {
    const now      = new Date().toISOString();
    const snapshot = await rtdb.ref('gracePeriods').get();

    if (snapshot.exists()) {
      const gracePeriods = snapshot.val() as Record<string, GracePeriod>;

      for (const [machineId, gp] of Object.entries(gracePeriods)) {
        try {
          if (gp.status !== 'active') continue;
          if (gp.expiresAt > now) continue; // not expired yet

          console.log(`[Cron] Grace expired: ${machineId} user=${gp.userId}`);

          // Mark expired — clients watching RTDB will dismiss modals + stop alarms
          await expireGracePeriod(machineId);

          // Remove from queue — ONCE, only here
          await removeUserFromQueue(machineId, gp.userId);

          // Notify removed user — ONCE
          await sendAndStoreNotification({
            userId:   gp.userId,
            type:     'removed_from_queue',
            title:    '❌ Removed from Queue',
            body:     `You were removed from Machine ${machineId} queue due to timeout.`,
            data:     { machineId },
            priority: 'normal',
          });

          // Promote next user
          await updateNextUserId(machineId);
          const nextUser = await getNextUser(machineId);

          if (nextUser) {
            await startGracePeriod(machineId, nextUser.userId, nextUser.name || 'Unknown');
            await notifyYourTurn(nextUser.userId, machineId);
            await sendAndStoreNotification({
              userId:   nextUser.userId,
              type:     'your_turn',
              title:    '🎉 Your Turn!',
              body:     `Machine ${machineId} is ready. You have 5 minutes!`,
              data:     { machineId },
              sound:    'alarm',
              priority: 'high',
            });
            results.gracePeriods.processed.push(`${machineId}: expired ${gp.userId}, promoted ${nextUser.userId}`);
          } else {
            results.gracePeriods.processed.push(`${machineId}: expired ${gp.userId}, queue empty`);
          }
        } catch (err: any) {
          console.error(`[Cron] Grace error for ${machineId}:`, err);
          results.gracePeriods.errors.push(`${machineId}: ${err.message}`);
        }
      }
    }
  } catch (err: any) {
    console.error('[Cron] Grace period scan failed:', err);
    results.gracePeriods.errors.push(`scan_failed: ${err.message}`);
  }

  // ─────────────────────────────────────────────
  // TASK 2: Incident Timeout (auto-buzzer)
  // ─────────────────────────────────────────────
  try {
    const now = new Date().toISOString();

    const expiredIncidents = await incidentsRef
      .where('status', '==', 'pending')
      .where('expiresAt', '<=', now)
      .get();

    for (const docSnap of expiredIncidents.docs) {
      try {
        const incident   = docSnap.data() as Incident;
        const incidentId = docSnap.id;

        await incidentsRef.doc(incidentId).update({
          status:          'timeout',
          resolvedAt:      now,
          buzzerTriggered: true,
          resolvedBy:      'cron',
        });

        await getCommandsRef(incident.machineId).update({
          buzzer:       true,
          buzzerAt:     now,
          buzzerReason: 'incident_timeout',
        });

        await sendAndStoreNotification({
          userId:   incident.intruderId,
          type:     'buzzer_triggered',
          title:    '🚨 Alert Triggered',
          body:     `Unauthorized access alert for Machine ${incident.machineId}.`,
          data:     { machineId: incident.machineId, incidentId },
          priority: 'high',
        });

        await sendAndStoreNotification({
          userId:   incident.nextUserId,
          type:     'buzzer_triggered',
          title:    '🚨 Auto-Alert Triggered',
          body:     `No response received. Buzzer activated for Machine ${incident.machineId}.`,
          data:     { machineId: incident.machineId, incidentId },
        });

        results.incidents.processed.push(`${incidentId}: ${incident.machineId} buzzer triggered`);
      } catch (err: any) {
        console.error(`[Cron] Incident error ${docSnap.id}:`, err);
        results.incidents.errors.push(`${docSnap.id}: ${err.message}`);
      }
    }
  } catch (err: any) {
    console.error('[Cron] Incident scan failed:', err);
    results.incidents.errors.push(`scan_failed: ${err.message}`);
  }

  res.status(200).json({
    success:   true,
    timestamp: new Date().toISOString(),
    gracePeriods: {
      processed: results.gracePeriods.processed.length,
      errors:    results.gracePeriods.errors.length,
      details:   results.gracePeriods,
    },
    incidents: {
      processed: results.incidents.processed.length,
      errors:    results.incidents.errors.length,
      details:   results.incidents,
    },
  });
}
