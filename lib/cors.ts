/**
 * CORS Helper for Vercel API Routes
 * 
 * Handles preflight OPTIONS requests and adds CORS headers
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Add CORS headers to response
 */
export function setCorsHeaders(res: VercelResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

/**
 * Handle CORS preflight and return true if request was handled
 */
export function handleCors(req: VercelRequest, res: VercelResponse): boolean {
  setCorsHeaders(res);
  
  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  
  return false;
}
