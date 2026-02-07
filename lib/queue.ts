/**
 * Queue Management Helper
 * 
 * Handles queue operations: get next user, remove user, update positions
 */

import { queuesRef, machinesRef, usersRef } from './firebase';
import { FieldValue } from 'firebase-admin/firestore';

// Queue user structure
export interface QueueUser {
  position: number;
  userId: string;
  name: string;
  avatar: string | null;
  queueToken: string;
  joinedAt: string;
  lastActiveAt?: string;
}

// Queue document structure
export interface QueueDocument {
  machineId: string;
  status: 'Active' | 'Paused' | 'Closed';
  lastUpdated: string;
  users: QueueUser[];
}

/**
 * Get the next user in queue (earliest joinedAt, position 1)
 */
export async function getNextUser(machineId: string): Promise<QueueUser | null> {
  try {
    const queueDoc = await queuesRef.doc(machineId).get();
    if (!queueDoc.exists) return null;

    const queueData = queueDoc.data() as QueueDocument;
    if (!queueData.users || queueData.users.length === 0) return null;

    // Sort by position (should already be sorted, but ensure)
    const sortedUsers = [...queueData.users].sort((a, b) => a.position - b.position);
    return sortedUsers[0] || null;
  } catch (error) {
    console.error(`Failed to get next user for ${machineId}:`, error);
    return null;
  }
}

/**
 * Get user's position in queue
 */
export async function getUserPosition(machineId: string, userId: string): Promise<number | null> {
  try {
    const queueDoc = await queuesRef.doc(machineId).get();
    if (!queueDoc.exists) return null;

    const queueData = queueDoc.data() as QueueDocument;
    const user = queueData.users?.find(u => u.userId === userId);
    return user?.position || null;
  } catch (error) {
    console.error(`Failed to get user position:`, error);
    return null;
  }
}

/**
 * Check if user is in queue
 */
export async function isUserInQueue(machineId: string, userId: string): Promise<boolean> {
  const position = await getUserPosition(machineId, userId);
  return position !== null;
}

/**
 * Remove user from queue and reorder positions
 */
export async function removeUserFromQueue(machineId: string, userId: string): Promise<boolean> {
  try {
    const queueDoc = await queuesRef.doc(machineId).get();
    if (!queueDoc.exists) return false;

    const queueData = queueDoc.data() as QueueDocument;
    const userIndex = queueData.users?.findIndex(u => u.userId === userId);
    
    if (userIndex === undefined || userIndex === -1) return false;

    // Remove user and reorder positions
    const updatedUsers = queueData.users
      .filter(u => u.userId !== userId)
      .map((user, index) => ({
        ...user,
        position: index + 1,
      }));

    await queuesRef.doc(machineId).update({
      users: updatedUsers,
      lastUpdated: new Date().toISOString(),
    });

    console.log(`Removed user ${userId} from queue ${machineId}`);
    return true;
  } catch (error) {
    console.error(`Failed to remove user from queue:`, error);
    return false;
  }
}

/**
 * Add user to queue
 */
export async function addUserToQueue(
  machineId: string, 
  userId: string, 
  name: string, 
  avatar: string | null
): Promise<QueueUser | null> {
  try {
    const queueDoc = await queuesRef.doc(machineId).get();
    
    let users: QueueUser[] = [];
    if (queueDoc.exists) {
      const queueData = queueDoc.data() as QueueDocument;
      users = queueData.users || [];
      
      // Check if already in queue
      if (users.some(u => u.userId === userId)) {
        console.log(`User ${userId} already in queue`);
        return users.find(u => u.userId === userId) || null;
      }
    }

    const newUser: QueueUser = {
      position: users.length + 1,
      userId,
      name,
      avatar,
      queueToken: `q_${Date.now()}${Math.random().toString(36).substring(2, 7)}`,
      joinedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };

    users.push(newUser);

    await queuesRef.doc(machineId).set({
      machineId,
      status: 'Active',
      lastUpdated: new Date().toISOString(),
      users,
    }, { merge: true });

    console.log(`Added user ${userId} to queue ${machineId} at position ${newUser.position}`);
    return newUser;
  } catch (error) {
    console.error(`Failed to add user to queue:`, error);
    return null;
  }
}

/**
 * Update nextUserId in machine document
 */
export async function updateNextUserId(machineId: string): Promise<string | null> {
  try {
    const nextUser = await getNextUser(machineId);
    const nextUserId = nextUser?.userId || null;

    await machinesRef.doc(machineId).update({
      nextUserId,
      lastUpdated: FieldValue.serverTimestamp(),
    });

    console.log(`Updated nextUserId for ${machineId}: ${nextUserId}`);
    return nextUserId;
  } catch (error) {
    console.error(`Failed to update nextUserId:`, error);
    return null;
  }
}

/**
 * Set current user and update nextUserId
 */
export async function setCurrentUser(machineId: string, userId: string | null): Promise<boolean> {
  try {
    const updateData: Record<string, any> = {
      currentUserId: userId,
      lastUpdated: FieldValue.serverTimestamp(),
    };

    // If setting a user, update status
    if (userId) {
      updateData.status = 'In Use';
    } else {
      updateData.status = 'Available';
    }

    await machinesRef.doc(machineId).update(updateData);

    // Update nextUserId after changing currentUser
    await updateNextUserId(machineId);

    console.log(`Set currentUserId for ${machineId}: ${userId}`);
    return true;
  } catch (error) {
    console.error(`Failed to set current user:`, error);
    return false;
  }
}

/**
 * Get machine document
 */
export async function getMachine(machineId: string): Promise<Record<string, any> | null> {
  try {
    const machineDoc = await machinesRef.doc(machineId).get();
    if (!machineDoc.exists) return null;
    return machineDoc.data() || null;
  } catch (error) {
    console.error(`Failed to get machine ${machineId}:`, error);
    return null;
  }
}

/**
 * Get user details
 */
export async function getUser(userId: string): Promise<Record<string, any> | null> {
  try {
    const userDoc = await usersRef.doc(userId).get();
    if (!userDoc.exists) return null;
    return { id: userDoc.id, ...userDoc.data() };
  } catch (error) {
    console.error(`Failed to get user ${userId}:`, error);
    return null;
  }
}

/**
 * Update user's lastActiveAt in queue
 */
export async function updateUserActivity(machineId: string, userId: string): Promise<boolean> {
  try {
    const queueDoc = await queuesRef.doc(machineId).get();
    if (!queueDoc.exists) return false;

    const queueData = queueDoc.data() as QueueDocument;
    const updatedUsers = queueData.users.map(user => {
      if (user.userId === userId) {
        return { ...user, lastActiveAt: new Date().toISOString() };
      }
      return user;
    });

    await queuesRef.doc(machineId).update({
      users: updatedUsers,
      lastUpdated: new Date().toISOString(),
    });

    return true;
  } catch (error) {
    console.error(`Failed to update user activity:`, error);
    return false;
  }
}
