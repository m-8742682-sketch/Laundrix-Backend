import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cleanupDeletedUser } from '../lib/queue';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }

  try {
    await cleanupDeletedUser(userId);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('User deletion cleanup error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}