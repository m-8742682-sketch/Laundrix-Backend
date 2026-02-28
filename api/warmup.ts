/**
 * GET /api/warmup
 *
 * Lightweight endpoint called by the frontend at app launch to pre-warm
 * the Vercel serverless function and keep Firebase Admin initialized.
 * Also called every 5 minutes by Vercel cron to prevent cold starts.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import { db, rtdb } from '../lib/firebase'; // ensures Firebase Admin is initialized

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (handleCors(req, res)) return;

  // Warm up both Firestore and RTDB connections in parallel
  await Promise.allSettled([
    db.collection('_warmup').doc('ping').set(
      { ts: Date.now() },
      { merge: true }
    ),
    rtdb.ref('_warmup').set({ ts: Date.now() }),
  ]);

  res.status(200).json({
    status: 'warm',
    timestamp: new Date().toISOString(),
    region: process.env.VERCEL_REGION || 'unknown',
  });
}
