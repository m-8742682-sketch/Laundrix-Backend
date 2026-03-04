/**
 * POST /api/claim-grace
 *
 * Called when nextUserId successfully scans QR during grace period.
 * Sets status → "claimed" so ALL clients (user + admins) immediately
 * dismiss their grace modals and stop alarms.
 *
 * Body: { machineId: string, userId: string }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import { rtdb } from '../lib/firebase';
import { claimGracePeriod } from '../lib/grace';
import type { GracePeriod, ApiResponse } from '../lib/types';

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
    const { machineId, userId } = req.body as { machineId: string; userId: string };

    if (!machineId || !userId) {
      res.status(400).json({ success: false, error: 'Missing machineId or userId' });
      return;
    }

    const gracePeriodRef      = rtdb.ref(`gracePeriods/${machineId}`);
    const gracePeriodSnapshot = await gracePeriodRef.get();

    if (!gracePeriodSnapshot.exists()) {
      // No grace period active — that's fine, scan already handled it
      res.status(200).json({ success: true, message: 'No active grace period', data: { cleared: false } });
      return;
    }

    const gracePeriod = gracePeriodSnapshot.val() as GracePeriod;

    // Verify correct user
    if (gracePeriod.userId !== userId) {
      res.status(403).json({ success: false, error: 'Grace period is for a different user' });
      return;
    }

    // Already handled
    if (gracePeriod.status !== 'active') {
      res.status(200).json({ success: true, message: `Grace already ${gracePeriod.status}`, data: { cleared: false } });
      return;
    }

    // Mark claimed — all listening clients will immediately stop countdown + dismiss modal
    await claimGracePeriod(machineId);

    console.log(`[claim-grace] ${userId} claimed grace on ${machineId}`);
    res.status(200).json({ success: true, message: 'Grace period cleared.', data: { cleared: true } });

  } catch (error) {
    console.error('[claim-grace] error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}
