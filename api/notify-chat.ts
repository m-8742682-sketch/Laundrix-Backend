/**
 * POST /api/notify-chat
 * 
 * Send notification when a new chat message is sent
 * 
 * Request body: { 
 *   senderId: string,
 *   senderName: string,
 *   receiverId: string,      // Single recipient for direct chats
 *   message: string,
 *   messageType?: 'text' | 'audio' | 'image'
 * }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import { sendAndStoreNotification } from '../lib/fcm';

interface NotifyChatRequest {
  senderId: string;
  senderName: string;
  receiverId: string;
  message: string;
  messageType?: 'text' | 'audio' | 'image';
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Handle CORS
  if (handleCors(req, res)) return;

  // Only allow POST
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  try {
    const { 
      senderId, 
      senderName, 
      receiverId,
      message, 
      messageType = 'text'
    } = req.body as NotifyChatRequest;

    // Validate input
    if (!senderId || !receiverId || !message) {
      res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: senderId, receiverId, message' 
      });
      return;
    }

    // Don't notify yourself
    if (senderId === receiverId) {
      res.status(200).json({
        success: true,
        message: 'Sender and receiver are the same, skipping notification',
      });
      return;
    }

    console.log(`[notify-chat] Sending notification:`, {
      senderId,
      senderName,
      receiverId,
      messageType,
    });

    // Format message body based on type
    let body = message;
    if (messageType === 'audio') {
      body = '🎵 Voice message';
    } else if (messageType === 'image') {
      body = '📷 Image';
    } else if (message.length > 100) {
      body = message.substring(0, 100) + '...';
    }

    // Send push notification AND store in Firestore
    const result = await sendAndStoreNotification({
      userId: receiverId,
      type: 'chat_message',
      title: `💬 ${senderName || 'Someone'}`,
      body,
      data: { 
        senderId, 
        senderName: senderName || 'Unknown',
        messageType,
      },
      sound: 'default',
      priority: 'high',
      channelId: 'chat',
    });

    console.log(`[notify-chat] Notification sent: ${result.sent}, stored: ${result.notificationId}`);

    res.status(200).json({
      success: true,
      message: 'Chat notification sent',
      data: { 
        sent: result.sent, 
        notificationId: result.notificationId 
      }
    });

  } catch (error) {
    console.error('[notify-chat] Error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
}
