/**
 * POST /api/cleanup-queue
 * 
 * Auto-deletes users from queues where their uid no longer exists in users collection.
 * Should be called periodically (e.g., via cron job or scheduled function).
 * 
 * Can also be triggered manually for maintenance.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import { queuesRef, usersRef } from '../lib/firebase';
import { QueueDocument, QueueUser } from '../lib/queue';

interface CleanupResult {
  queueId: string;
  removedUsers: string[];
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Handle CORS
  if (handleCors(req, res)) return;

  // Allow both GET and POST for flexibility
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  try {
    const results: CleanupResult[] = [];
    let totalRemoved = 0;

    // Get all queues
    const queuesSnapshot = await queuesRef.get();

    for (const queueDoc of queuesSnapshot.docs) {
      const queueData = queueDoc.data() as QueueDocument;
      const users = queueData.users ?? [];
      
      if (users.length === 0) continue;

      // Check which users still exist
      const removedUsers: string[] = [];
      const validUsers: QueueUser[] = [];

      for (const queueUser of users) {
        const userDoc = await usersRef.doc(queueUser.userId).get();
        
        if (userDoc.exists) {
          validUsers.push(queueUser);
        } else {
          removedUsers.push(queueUser.userId);
          console.log(`User ${queueUser.userId} no longer exists, removing from queue ${queueDoc.id}`);
        }
      }

      // If any users were removed, update the queue
      if (removedUsers.length > 0) {
        // Reorder positions
        const reorderedUsers = validUsers.map((user, index) => ({
          ...user,
          position: index + 1,
        }));

        await queuesRef.doc(queueDoc.id).update({
          users: reorderedUsers,
          lastUpdated: new Date().toISOString(),
        });

        results.push({
          queueId: queueDoc.id,
          removedUsers,
        });

        totalRemoved += removedUsers.length;
      }
    }

    console.log(`Queue cleanup completed. Removed ${totalRemoved} invalid users from ${results.length} queues.`);

    res.status(200).json({
      success: true,
      message: `Cleanup completed`,
      data: {
        totalRemoved,
        queuesAffected: results.length,
        details: results,
      },
    });

  } catch (error) {
    console.error('Queue cleanup error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
}
