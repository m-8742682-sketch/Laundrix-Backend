/**
 * GET /api/health
 * 
 * Health check endpoint for monitoring
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  res.status(200).json({
    status: 'ok',
    service: 'laundrix-backend',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
}
