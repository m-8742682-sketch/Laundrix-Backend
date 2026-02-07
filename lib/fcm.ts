/**
 * Firebase Cloud Messaging Helper
 * 
 * Sends push notifications to users with proper lock screen support
 */

import { messaging, usersRef } from './firebase';

// Notification types for different scenarios
export type NotificationType = 
  | 'your_turn'           // nextUserId's turn to use machine
  | 'grace_warning'       // 2 min passed, 3 min left
  | 'removed_from_queue'  // Removed due to timeout
  | 'unauthorized_alert'  // Someone trying to use your machine
  | 'unauthorized_warning'// Warning to the intruder
  | 'buzzer_triggered'    // Buzzer was activated
  | 'clothes_ready'       // Washing done, collect clothes
  | 'session_started'     // Successfully started session
  | 'session_ended';      // Session ended

interface NotificationPayload {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, string>;
  sound?: 'default' | 'alarm' | 'urgent';
  priority?: 'normal' | 'high';
}

/**
 * Get user's FCM token from Firestore
 */
async function getUserFcmToken(userId: string): Promise<string | null> {
  try {
    const userDoc = await usersRef.doc(userId).get();
    if (!userDoc.exists) return null;
    
    const userData = userDoc.data();
    return userData?.fcmToken || null;
  } catch (error) {
    console.error(`Failed to get FCM token for user ${userId}:`, error);
    return null;
  }
}

/**
 * Send push notification to a user
 */
export async function sendNotification(payload: NotificationPayload): Promise<boolean> {
  const { userId, type, title, body, data = {}, sound = 'default', priority = 'high' } = payload;

  try {
    const fcmToken = await getUserFcmToken(userId);
    if (!fcmToken) {
      console.warn(`No FCM token for user ${userId}`);
      return false;
    }

    // Determine sound file based on type
    const soundFile = sound === 'alarm' ? 'alarm_loop.wav' : 
                      sound === 'urgent' ? 'urgent.wav' : 'default';

    const message = {
      token: fcmToken,
      notification: {
        title,
        body,
      },
      data: {
        type,
        ...data,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      android: {
        priority: priority as 'normal' | 'high',
        notification: {
          channelId: priority === 'high' ? 'urgent_alerts' : 'general',
          sound: soundFile,
          defaultSound: sound === 'default',
          defaultVibrateTimings: true,
          notificationCount: 1,
          visibility: 'public' as const, // Show on lock screen
        },
      },
      apns: {
        headers: {
          'apns-priority': priority === 'high' ? '10' : '5',
        },
        payload: {
          aps: {
            sound: sound === 'alarm' ? { 
              critical: 1, 
              name: 'alarm_loop.caf', 
              volume: 1.0 
            } : soundFile,
            badge: 1,
            'content-available': 1,
            'mutable-content': 1,
            'interruption-level': priority === 'high' ? 'critical' : 'active',
          },
        },
      },
    };

    await messaging.send(message);
    console.log(`Notification sent to ${userId}: ${type}`);
    return true;
  } catch (error) {
    console.error(`Failed to send notification to ${userId}:`, error);
    return false;
  }
}

/**
 * Send "Your Turn" notification with alarm sound
 */
export async function notifyYourTurn(userId: string, machineId: string): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'your_turn',
    title: '🎉 Your Turn!',
    body: `Machine ${machineId} is ready for you. You have 5 minutes to scan the QR code.`,
    data: { machineId },
    sound: 'alarm',  // Loops on lock screen
    priority: 'high',
  });
}

/**
 * Send grace period warning (2 min passed)
 */
export async function notifyGraceWarning(userId: string, machineId: string): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'grace_warning',
    title: '⚠️ Hurry Up!',
    body: `Only 3 minutes left to claim Machine ${machineId}!`,
    data: { machineId },
    sound: 'urgent',
    priority: 'high',
  });
}

/**
 * Send removed from queue notification
 */
export async function notifyRemovedFromQueue(userId: string, machineId: string): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'removed_from_queue',
    title: '❌ Removed from Queue',
    body: `You were removed from Machine ${machineId} queue due to timeout.`,
    data: { machineId },
    sound: 'default',
    priority: 'normal',
  });
}

/**
 * Send unauthorized alert to nextUserId (with alarm)
 */
export async function notifyUnauthorizedAlert(
  userId: string, 
  machineId: string, 
  incidentId: string,
  intruderName: string
): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'unauthorized_alert',
    title: '🚨 Someone at Your Machine!',
    body: `${intruderName} is trying to use Machine ${machineId}. Is this you?`,
    data: { machineId, incidentId, intruderName },
    sound: 'alarm',
    priority: 'high',
  });
}

/**
 * Send warning to intruder
 */
export async function notifyUnauthorizedWarning(
  userId: string, 
  machineId: string
): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'unauthorized_warning',
    title: '⚠️ Not Your Turn!',
    body: `Machine ${machineId} is not available for you. If you proceed, you will be reported.`,
    data: { machineId },
    sound: 'urgent',
    priority: 'high',
  });
}

/**
 * Notify buzzer was triggered
 */
export async function notifyBuzzerTriggered(
  userId: string, 
  machineId: string,
  reason: string
): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'buzzer_triggered',
    title: '🚨 Alert Triggered',
    body: reason,
    data: { machineId },
    sound: 'default',
    priority: 'high',
  });
}

/**
 * Notify clothes are ready
 */
export async function notifyClothesReady(userId: string, machineId: string): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'clothes_ready',
    title: '👕 Clothes Ready!',
    body: `Your laundry at Machine ${machineId} is done. Please collect your clothes.`,
    data: { machineId },
    sound: 'alarm',  // Ring until collected
    priority: 'high',
  });
}

/**
 * Notify session started
 */
export async function notifySessionStarted(userId: string, machineId: string): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'session_started',
    title: '✅ Session Started',
    body: `You are now using Machine ${machineId}. Happy washing!`,
    data: { machineId },
    sound: 'default',
    priority: 'normal',
  });
}

/**
 * Notify session ended
 */
export async function notifySessionEnded(userId: string, machineId: string): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'session_ended',
    title: '👋 Session Ended',
    body: `Your session at Machine ${machineId} has ended.`,
    data: { machineId },
    sound: 'default',
    priority: 'normal',
  });
}

/**
 * Store notification in Firestore for history
 */
export async function storeNotification(
  userId: string,
  type: NotificationType,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<string> {
  const { notificationsRef } = await import('./firebase');
  
  const notification = {
    userId,
    type,
    title,
    body,
    data: data || {},
    read: false,
    created_at: new Date().toISOString(),
  };

  const docRef = await notificationsRef.add(notification);
  return docRef.id;
}

/**
 * Send notification and store in Firestore
 */
export async function sendAndStoreNotification(payload: NotificationPayload): Promise<{
  sent: boolean;
  notificationId: string;
}> {
  const [sent, notificationId] = await Promise.all([
    sendNotification(payload),
    storeNotification(payload.userId, payload.type, payload.title, payload.body, payload.data),
  ]);

  return { sent, notificationId };
}
