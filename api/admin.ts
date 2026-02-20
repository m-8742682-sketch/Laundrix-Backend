/**
 * POST /api/admin
 *
 * Admin / maintenance tasks — merged into one file to stay within
 * Vercel free tier 12-function limit.
 *
 * Pass { action } in the request body to select the task:
 *
 *   action: "cleanup-queue"   — remove deleted users from all queues
 *   action: "user-deleted"    — remove a specific deleted user from all queues
 *
 * Body for "user-deleted": { action: "user-deleted", userId: string }
 * Body for "cleanup-queue": { action: "cleanup-queue" }
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleCors } from "../lib/cors";
import { queuesRef, usersRef } from "../lib/firebase";
import { cleanupDeletedUser, QueueDocument, QueueUser } from "../lib/queue";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (handleCors(req, res)) return;

  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "Method not allowed" });
    return;
  }

  const { action, userId } = req.body;

  // ─────────────────────────────────────────────
  // action: "user-deleted"
  // Called when a user account is deleted from Firebase Auth.
  // Removes that user from every queue they're in.
  // ─────────────────────────────────────────────
  if (action === "user-deleted") {
    if (!userId) {
      res.status(400).json({ success: false, error: "Missing userId" });
      return;
    }
    try {
      await cleanupDeletedUser(userId);
      res.status(200).json({
        success: true,
        message: `User ${userId} removed from all queues`,
      });
    } catch (err: any) {
      console.error("user-deleted cleanup error:", err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
    return;
  }

  // ─────────────────────────────────────────────
  // action: "cleanup-queue"
  // Scans every queue and removes any userId that no longer
  // exists in the users Firestore collection.
  // Run periodically for maintenance.
  // ─────────────────────────────────────────────
  if (action === "cleanup-queue") {
    try {
      const results: { queueId: string; removedUsers: string[] }[] = [];
      let totalRemoved = 0;

      const queuesSnapshot = await queuesRef.get();

      for (const queueDoc of queuesSnapshot.docs) {
        const queueData = queueDoc.data() as QueueDocument;
        const users = queueData.users ?? [];
        if (users.length === 0) continue;

        const removedUsers: string[] = [];
        const validUsers: QueueUser[] = [];

        for (const queueUser of users) {
          const userDoc = await usersRef.doc(queueUser.userId).get();
          if (userDoc.exists) {
            validUsers.push(queueUser);
          } else {
            removedUsers.push(queueUser.userId);
            console.log(
              `[Admin] User ${queueUser.userId} not found — removing from queue ${queueDoc.id}`
            );
          }
        }

        if (removedUsers.length > 0) {
          const reorderedUsers = validUsers.map((u, i) => ({
            ...u,
            position: i + 1,
          }));

          await queuesRef.doc(queueDoc.id).update({
            users:       reorderedUsers,
            lastUpdated: new Date().toISOString(),
          });

          results.push({ queueId: queueDoc.id, removedUsers });
          totalRemoved += removedUsers.length;
        }
      }

      res.status(200).json({
        success: true,
        message: `Cleanup complete`,
        data: {
          totalRemoved,
          queuesAffected: results.length,
          details: results,
        },
      });
    } catch (err: any) {
      console.error("cleanup-queue error:", err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
    return;
  }

  // Unknown action
  res.status(400).json({
    success: false,
    error: `Unknown action "${action}". Use: user-deleted | cleanup-queue`,
  });
}
