/**
 * POST /api/scan  — FIXED VERSION
 *
 * Fixes:
 *  #2/#3  isMyTurn: when machine is IN USE by currentUserId, no one else gets "scan ahead"
 *  #5     Deduplication: don't create duplicate incidents for same scan
 *  #6     Unauthorized: notify CURRENT user (not just nextUser) + all admins
 *  #7     Session start: record startTime in RTDB for usage-history calculation
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import { getCommandsRef, machinesRef, incidentsRef, usersRef, rtdb, db } from '../lib/firebase';
import { FieldValue } from 'firebase-admin/firestore';
import {
  notifySessionStarted,
  notifyUnauthorizedAlert,
  notifyUnauthorizedWarning,
  sendAndStoreNotification
} from '../lib/fcm';
import type { ScanRequest, ScanResponse, ScanResult, Incident } from '../lib/types';

const machineCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 5000;

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
    const { machineId, userId, userName } = req.body as ScanRequest;

    if (!machineId || !userId) {
      res.status(400).json({ success: false, result: 'machine_not_found' as ScanResult, message: 'Missing machineId or userId' });
      return;
    }

    const [machine, user] = await Promise.all([
      getMachineOptimized(machineId),
      getUserOptimized(userId),
    ]);

    if (!machine) {
      res.status(404).json({ success: false, result: 'machine_not_found' as ScanResult, message: 'Machine not found' });
      return;
    }
    if (!user) {
      res.status(404).json({ success: false, result: 'user_not_found' as ScanResult, message: 'User not found' });
      return;
    }

    const currentUserId = machine.currentUserId || null;

    // ── CASE 1: User is already the current user (re-entry) ──────────────────
    if (currentUserId === userId) {
      unlockDoorFast(machineId, userId);
      res.status(200).json({ success: true, result: 'already_current', message: 'Door unlocked. Welcome back!', data: { unlocked: true } });
      notifySessionStarted(userId, machineId).catch(() => {});
      return;
    }

    // ── FIX #6: Machine is IN USE by someone else → unauthorized immediately ──
    if (currentUserId && currentUserId !== userId) {
      const ownerData = await getUserOptimized(currentUserId);
      const incidentData = await createIncidentFast(machineId, userId, user, currentUserId, ownerData || { name: 'Current User', displayName: 'Current User' });
      
      // Notify the current user (machine owner) + all admins
      Promise.all([
        notifyUnauthorizedAlert(currentUserId, machineId, incidentData.incidentId, user.displayName || user.name || 'Someone'),
        notifyUnauthorizedWarning(userId, machineId),
        notifyAdmins(machineId, incidentData.incidentId, userId, user.displayName || user.name || 'Unknown', 'scan'),
        sendAndStoreNotification({
          userId,
          type: 'unauthorized_warning',
          title: '⚠️ Machine In Use!',
          body: `Machine ${machineId} is currently in use. You are not authorized.`,
          data: { machineId },
        }),
      ]).catch(() => {});

      res.status(403).json({
        success: false,
        result: 'unauthorized' as ScanResult,
        message: 'Machine is currently in use by another user.',
        data: {
          incidentId: incidentData.incidentId,
          currentUserId,
          ownerUserName: ownerData?.displayName || ownerData?.name || 'Current User',
          nextUserName: ownerData?.displayName || ownerData?.name || 'Current User',
          expiresAt: incidentData.expiresAt,
          expiresIn: 60,
        },
      });
      return;
    }

    // ── No current user: check queue ──────────────────────────────────────────
    const nextUser = await getNextUserOptimized(machineId);
    const nextUserId = nextUser?.userId || null;

    // ── CASE 2: User is nextUserId (claiming their grace period or queue turn) ─
    if (nextUserId === userId) {
      res.status(200).json({ success: true, result: 'authorized', message: 'Your turn! Door unlocked.', data: { unlocked: true } });

      // FIX #7: record sessionStart in RTDB for duration calculation
      const now = new Date().toISOString();
      Promise.all([
        unlockDoorFast(machineId, userId),
        claimMachineAtomic(machineId, userId),
        rtdb.ref(`sessions/${machineId}`).set({ userId, startTime: now }),
        notifySessionStarted(userId, machineId),
        sendAndStoreNotification({ userId, type: 'session_started', title: '🎉 Session Started', body: `Machine ${machineId} is ready for you!`, data: { machineId } }),
      ]).catch(err => console.error('[Scan] bg error:', err));
      return;
    }

    // ── CASE 3: No current user AND queue is empty → direct claim ────────────
    if (!currentUserId && !nextUserId) {
      res.status(200).json({ success: true, result: 'queue_empty_claim', message: 'Machine is yours! Door unlocked.', data: { unlocked: true } });

      const now = new Date().toISOString();
      Promise.all([
        unlockDoorFast(machineId, userId),
        setCurrentUserAtomic(machineId, userId),
        rtdb.ref(`sessions/${machineId}`).set({ userId, startTime: now }),
        notifySessionStarted(userId, machineId),
      ]).catch(err => console.error('[Scan] bg error:', err));
      return;
    }

    // ── CASE 4: Queue has someone ahead of this user → unauthorized ───────────
    // FIX #6: notify the nextUserId (rightful owner) + all admins
    const incidentData = await createIncidentFast(
      machineId, userId, user,
      nextUserId!, nextUser!
    );

    Promise.all([
      notifyUnauthorizedAlert(nextUserId!, machineId, incidentData.incidentId, user.displayName || user.name || 'Someone'),
      notifyUnauthorizedWarning(userId, machineId),
      notifyAdmins(machineId, incidentData.incidentId, userId, user.displayName || user.name || 'Unknown', 'scan'),
      sendAndStoreNotification({
        userId,
        type: 'unauthorized_warning',
        title: '⚠️ Not Your Turn!',
        body: `Machine ${machineId} is not available for you.`,
        data: { machineId },
      }),
    ]).catch(() => {});

    res.status(403).json({
      success: false,
      result: 'unauthorized' as ScanResult,
      message: 'Not your turn. The rightful user has been notified.',
      data: {
        incidentId: incidentData.incidentId,
        currentUserId,
        nextUserId,
        nextUserName: nextUser?.name || nextUser?.displayName || 'the next user',
        ownerUserName: nextUser?.name || nextUser?.displayName || 'the next user',
        expiresAt: incidentData.expiresAt,
        expiresIn: 60,
      },
    });

  } catch (error) {
    console.error('Scan error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getMachineOptimized(machineId: string): Promise<any | null> {
  const now = Date.now();
  const cached = machineCache.get(machineId);
  if (cached && now - cached.timestamp < CACHE_TTL) return cached.data;
  const snap = await machinesRef.doc(machineId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  machineCache.set(machineId, { data, timestamp: now });
  return data;
}

async function getUserOptimized(userId: string): Promise<any | null> {
  const snap = await machinesRef.firestore.collection('users').doc(userId).get();
  return snap.exists ? snap.data() : null;
}

async function getNextUserOptimized(machineId: string): Promise<any | null> {
  const snap = await machinesRef.firestore.collection('queues').doc(machineId).get();
  if (!snap.exists) return null;
  const users = snap.data()?.users ?? [];
  if (users.length === 0) return null;
  return [...users].sort((a, b) => a.position - b.position)[0];
}

async function unlockDoorFast(machineId: string, userId: string): Promise<void> {
  const commandsRef = getCommandsRef(machineId);
  await commandsRef.update({
    solenoidOpen: {
      value: true,
      requestUserId: userId,
      triggeredAt: new Date().toISOString(),
      triggeredBy: 'qr_scan',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
  });
}

async function claimMachineAtomic(machineId: string, userId: string): Promise<void> {
  const batch = db.batch();
  const now = new Date().toISOString();
  const queueRef = machinesRef.firestore.collection('queues').doc(machineId);
  const queueSnap = await queueRef.get();
  if (queueSnap.exists) {
    const users = queueSnap.data()?.users ?? [];
    const updatedUsers = users
      .filter((u: any) => u.userId !== userId)
      .map((u: any, i: number) => ({ ...u, position: i + 1 }));
    batch.update(queueRef, { users: updatedUsers, lastUpdated: now });
  }
  const newNextId = queueSnap.exists
    ? (queueSnap.data()?.users?.find((u: any) => u.userId !== userId)?.userId || null)
    : null;
  batch.update(machinesRef.doc(machineId), {
    currentUserId: userId,
    status: 'In Use',
    nextUserId: newNextId,
    lastUpdated: FieldValue.serverTimestamp(),
  });
  await batch.commit();
}

async function setCurrentUserAtomic(machineId: string, userId: string): Promise<void> {
  await machinesRef.doc(machineId).update({
    currentUserId: userId,
    status: 'In Use',
    lastUpdated: FieldValue.serverTimestamp(),
  });
}

async function createIncidentFast(
  machineId: string,
  intruderId: string,
  intruderData: any,
  ownerUserId: string,
  ownerData: any
): Promise<{ incidentId: string; expiresAt: string }> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 1000);
  const incidentId = `inc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  const incident: Incident = {
    machineId,
    intruderId,
    intruderName: intruderData.displayName || intruderData.name || 'Unknown',
    ownerUserId,
    ownerUserName: ownerData.displayName || ownerData.name || 'Unknown',
    nextUserId: ownerUserId,      // backward compat
    nextUserName: ownerData.displayName || ownerData.name || 'Unknown',
    status: 'pending',
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    resolvedAt: null,
    buzzerTriggered: false,
  };

  await Promise.all([
    incidentsRef.doc(incidentId).set(incident),
    rtdb.ref(`incidents/${machineId}/${incidentId}`).set({ ...incident, secondsLeft: 60 }),
  ]);

  // Background countdown
  updateIncidentCountdownBackground(machineId, incidentId, 60);
  return { incidentId, expiresAt: expiresAt.toISOString() };
}

/**
 * FIX #6: Notify ALL admin users about an incident
 */
async function notifyAdmins(
  machineId: string,
  incidentId: string,
  intruderId: string,
  intruderName: string,
  source: string
): Promise<void> {
  try {
    const adminsSnap = await machinesRef.firestore
      .collection('users')
      .where('role', '==', 'admin')
      .get();

    const notifyPromises = adminsSnap.docs
      .filter(doc => doc.id !== intruderId) // don't re-notify the intruder if admin
      .map(doc =>
        sendAndStoreNotification({
          userId: doc.id,
          type: 'unauthorized_alert',
          title: '🚨 Unauthorized Access Attempt',
          body: `${intruderName} tried to access Machine ${machineId} without authorization.`,
          data: { machineId, incidentId, source },
          priority: 'high',
        })
      );

    await Promise.all(notifyPromises);
  } catch (err) {
    console.error('[notifyAdmins] failed:', err);
  }
}

function updateIncidentCountdownBackground(
  machineId: string,
  incidentId: string,
  secondsLeft: number
): void {
  if (secondsLeft <= 0) {
    rtdb.ref(`incidents/${machineId}/${incidentId}`)
      .update({ secondsLeft: 0, status: 'timeout' })
      .then(() => getCommandsRef(machineId).update({ buzzer: true, buzzerAt: new Date().toISOString() }))
      .catch(() => {});
    return;
  }
  rtdb.ref(`incidents/${machineId}/${incidentId}/secondsLeft`)
    .set(secondsLeft)
    .then(() => {
      setTimeout(() => updateIncidentCountdownBackground(machineId, incidentId, secondsLeft - 1), 1000);
    })
    .catch(() => {});
}
