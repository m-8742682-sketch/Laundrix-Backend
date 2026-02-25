/**
 * GET /api/warmup
 *
 * Lightweight endpoint called by the frontend at app launch to pre-warm
 * the Vercel serverless function and keep Firebase Admin initialized.
 * This eliminates the 4-7s cold-start penalty on first real API call.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import { db } from '../lib/firebase'; // ensures Firebase Admin is initialized

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (handleCors(req, res)) return;

  // Minimal Firestore ping to keep connection alive
  try {
    await db.collection('_warmup').doc('ping').set(
      { ts: Date.now() },
      { merge: true }
    );
  } catch {
    // Ignore - just warming the function
  }

  res.status(200).json({
    status: 'warm',
    timestamp: new Date().toISOString(),
    region: process.env.VERCEL_REGION || 'unknown',
  });
}
