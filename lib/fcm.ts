/**
 * Firebase Cloud Messaging Helper
 * 
 * Sends push notifications to users with proper lock screen support
 */

import { messaging, usersRef, notificationsRef } from './firebase';
import * as admin from 'firebase-admin';

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
  | 'session_ended'       // Session ended
  | 'queue_joined'        // Joined queue
  | 'queue_left'          // Left queue
  | 'chat_message'        // New chat message
  | 'voice_call'          // Incoming voice call
  | 'video_call'          // Incoming video call
  | 'missed_call'         // Missed voice call
  | 'missed_video';       // Missed video call

interface NotificationPayload {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, string>;
  sound?: 'default' | 'alarm' | 'urgent';
  priority?: 'normal' | 'high';
  channelId?: string;
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
  const { 
    userId, 
    type, 
    title, 
    body, 
    data = {}, 
    sound = 'default', 
    priority = 'high',
    channelId 
  } = payload;

  try {
    const fcmToken = await getUserFcmToken(userId);
    if (!fcmToken) {
      console.warn(`No FCM token for user ${userId}`);
      return false;
    }

    // Check if it's an Expo token
    if (fcmToken.startsWith('ExponentPushToken')) {
      // Send via Expo Push Notification Service
      const message = {
        to: fcmToken,
        sound: sound === 'alarm' ? 'default' : sound,
        title,
        body,
        data: {
          type,
          ...data,
        },
        priority: priority === 'high' ? 'high' : 'normal',
      };

      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Expo push failed: ${errorText}`);
      }

      console.log(`Expo notification sent to ${userId}: ${type}`);
      return true;
    }

    // Determine channel and sound based on type
    let androidChannel = channelId || 'default';
    let soundFile = 'default';
    
    if (sound === 'alarm') {
      soundFile = 'alarm.mp3';
      androidChannel = channelId || 'critical';
    } else if (sound === 'urgent') {
      soundFile = 'urgent.mp3';
      androidChannel = channelId || 'urgent';
    }

    // Special channels for specific types
    if (type === 'chat_message') {
      androidChannel = 'chat';
    } else if (type === 'voice_call' || type === 'video_call') {
      androidChannel = 'calls';
      soundFile = 'alarm.mp3';
    }

    const message: any = {
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
          channelId: androidChannel,
          sound: soundFile,
          defaultSound: sound === 'default',
          defaultVibrateTimings: true,
          notificationCount: 1,
          visibility: 'public' as const,
        },
      },
      apns: {
        headers: {
          'apns-priority': priority === 'high' ? '10' : '5',
        },
        payload: {
          aps: {
            sound: sound === 'alarm' 
              ? { critical: true, name: 'alarm.mp3', volume: 1.0 } 
              : soundFile,
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
 * Store notification in Firestore for history
 * Uses Firestore Timestamp for proper date handling
 */
export async function storeNotification(
  userId: string,
  type: NotificationType,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<string> {
  const notification = {
    userId,
    type,
    title,
    body,
    data: data || {},
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
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

// ============================================
// Convenience functions for specific notifications
// ============================================

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
    sound: 'alarm',
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
    sound: 'alarm',
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
 * Notify queue joined
 */
export async function notifyQueueJoined(userId: string, machineId: string, position: number): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'queue_joined',
    title: '✅ Joined Queue',
    body: `You are #${position} in line for Machine ${machineId}.`,
    data: { machineId, position: position.toString() },
    sound: 'default',
    priority: 'normal',
  });
}

/**
 * Notify new chat message
 */
export async function notifyChatMessage(
  userId: string, 
  senderName: string, 
  message: string,
  machineId: string
): Promise<boolean> {
  const truncatedMessage = message.length > 50 ? message.substring(0, 50) + '...' : message;
  
  return sendNotification({
    userId,
    type: 'chat_message',
    title: `💬 ${senderName}`,
    body: truncatedMessage,
    data: { machineId, senderName },
    sound: 'default',
    priority: 'high',
    channelId: 'chat',
  });
}

/**
 * Notify incoming voice call
 */
export async function notifyIncomingVoiceCall(
  userId: string, 
  callerName: string,
  callId: string
): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'voice_call',
    title: '📞 Incoming Call',
    body: `${callerName} is calling you`,
    data: { callId, callerName },
    sound: 'alarm',
    priority: 'high',
    channelId: 'calls',
  });
}

/**
 * Notify incoming video call
 */
export async function notifyIncomingVideoCall(
  userId: string, 
  callerName: string,
  callId: string
): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'video_call',
    title: '📹 Incoming Video Call',
    body: `${callerName} is video calling you`,
    data: { callId, callerName },
    sound: 'alarm',
    priority: 'high',
    channelId: 'calls',
  });
}

/**
 * Notify missed call
 */
export async function notifyMissedCall(
  userId: string, 
  callerName: string,
  isVideo: boolean = false
): Promise<boolean> {
  return sendNotification({
    userId,
    type: isVideo ? 'missed_video' : 'missed_call',
    title: isVideo ? '📹 Missed Video Call' : '📞 Missed Call',
    body: `You missed a ${isVideo ? 'video ' : ''}call from ${callerName}`,
    data: { callerName },
    sound: 'default',
    priority: 'normal',
  });
}
