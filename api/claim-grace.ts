/**
 * POST /api/claim-grace
 * 
 * Called when nextUserId successfully scans during grace period
 * This clears the grace period countdown
 * 
 * Request body: { machineId: string, userId: string }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import { rtdb } from '../lib/firebase';
import type { ApiResponse, GracePeriod } from '../lib/types';

interface ClaimGraceRequest {
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
    const { machineId, userId } = req.body as ClaimGraceRequest;

    // Validate input
    if (!machineId || !userId) {
      res.status(400).json({ 
        success: false, 
        error: 'Missing machineId or userId' 
      });
      return;
    }

    // Get grace period data
    const gracePeriodRef = rtdb.ref(`gracePeriods/${machineId}`);
    const gracePeriodSnapshot = await gracePeriodRef.get();
    
    if (!gracePeriodSnapshot.exists()) {
      // No grace period, that's okay - machine might have been claimed directly
      res.status(200).json({ 
        success: true, 
        message: 'No active grace period to clear',
        data: { cleared: false }
      });
      return;
    }

    const gracePeriod = gracePeriodSnapshot.val() as GracePeriod;

    // Verify this is the correct user
    if (gracePeriod.userId !== userId) {
      res.status(403).json({ 
        success: false, 
        error: 'Grace period is for a different user' 
      });
      return;
    }

    // Mark as claimed and clear
    await gracePeriodRef.update({
      status: 'claimed',
      claimedAt: new Date().toISOString(),
    });

    // Remove after a short delay (for logging purposes)
    setTimeout(async () => {
      await gracePeriodRef.remove();
    }, 5000);

    console.log(`Grace period claimed by ${userId} for ${machineId}`);

    res.status(200).json({
      success: true,
      message: 'Grace period cleared. Enjoy your wash!',
      data: { cleared: true }
    });

  } catch (error) {
    console.error('Claim grace error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
}
