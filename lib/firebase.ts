/**
 * Firebase Admin SDK Initialization
 * 
 * Uses environment variables set in Vercel:
 * - FIREBASE_PROJECT_ID
 * - FIREBASE_CLIENT_EMAIL
 * - FIREBASE_PRIVATE_KEY
 * - FIREBASE_DATABASE_URL
 */

import * as admin from 'firebase-admin';

// Initialize Firebase Admin (singleton pattern)
if (!admin.apps.length) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  
  if (!privateKey || !process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL) {
    throw new Error('Missing Firebase configuration environment variables');
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey,
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL || 
      `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.asia-southeast1.firebasedatabase.app`,
  });
}

// Export Firebase services
export const db = admin.firestore();
export const rtdb = admin.database();
export const auth = admin.auth();
export const messaging = admin.messaging();

// Firestore collection references
export const machinesRef = db.collection('machines');
export const queuesRef = db.collection('queues');
export const usersRef = db.collection('users');
export const notificationsRef = db.collection('notifications');
export const incidentsRef = db.collection('incidents');
export const usageHistoryRef = db.collection('usageHistory');

// RTDB references
export const getIotRef = (machineId: string) => rtdb.ref(`iot/${machineId}`);
export const getCommandsRef = (machineId: string) => rtdb.ref(`iot/${machineId}/commands`);

export default admin;
