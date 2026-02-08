/**
 * POST /api/notify-call
 * 
 * Send notification when someone initiates a call or when a call is missed
 * 
 * Request body: { 
 *   callId?: string,        // Required for incoming calls
 *   callerId: string,
 *   callerName: string,
 *   recipientId: string,
 *   isVideo: boolean,
 *   action: 'incoming' | 'missed'
 * }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import { 
  notifyIncomingVoiceCall, 
  notifyIncomingVideoCall,
  notifyMissedCall,
  sendAndStoreNotification 
} from '../lib/fcm';

interface NotifyCallRequest {
  callId?: string;
  callerId: string;
  callerName: string;
  recipientId: string;
  isVideo: boolean;
  action: 'incoming' | 'missed';
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
      callId,
      callerId, 
      callerName, 
      recipientId,
      isVideo,
      action = 'incoming'
    } = req.body as NotifyCallRequest;

    // Validate input
    if (!callerId || !callerName || !recipientId) {
      res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: callerId, callerName, recipientId' 
      });
      return;
    }

    console.log(`[notify-call] Processing ${action} call notification:`, {
      callId,
      callerId,
      callerName,
      recipientId,
      isVideo,
    });

    let sent = false;
    let stored = false;

    if (action === 'incoming') {
      // Incoming call notification
      if (!callId) {
        res.status(400).json({ 
          success: false, 
          error: 'Missing callId for incoming call' 
        });
        return;
      }

      // Send push notification
      if (isVideo) {
        sent = await notifyIncomingVideoCall(recipientId, callerName, callId);
      } else {
        sent = await notifyIncomingVoiceCall(recipientId, callerName, callId);
      }

      // Store notification in Firestore
      stored = await sendAndStoreNotification({
        userId: recipientId,
        type: isVideo ? 'video_call' : 'voice_call',
        title: isVideo ? '📹 Incoming Video Call' : '📞 Incoming Call',
        body: `${callerName} is ${isVideo ? 'video ' : ''}calling you`,
        data: { callId, callerId, callerName },
        sound: 'alarm',
        priority: 'high',
      });

      console.log(`[notify-call] Incoming ${isVideo ? 'video' : 'voice'} call notification sent: ${sent}, stored: ${stored}`);

    } else if (action === 'missed') {
      // Missed call notification
      sent = await notifyMissedCall(recipientId, callerName, isVideo);
      
      // Store notification in Firestore
      stored = await sendAndStoreNotification({
        userId: recipientId,
        type: isVideo ? 'missed_video' : 'missed_call',
        title: isVideo ? '📹 Missed Video Call' : '📞 Missed Call',
        body: `You missed a ${isVideo ? 'video ' : ''}call from ${callerName}`,
        data: { callerId, callerName, isVideo: String(isVideo) },
        sound: 'default',
        priority: 'normal',
      });

      console.log(`[notify-call] Missed ${isVideo ? 'video' : 'voice'} call notification sent: ${sent}, stored: ${stored}`);
    }

    res.status(200).json({
      success: true,
      message: `${action === 'incoming' ? 'Call' : 'Missed call'} notification processed`,
      data: { sent, stored }
    });

  } catch (error) {
    console.error('[notify-call] Error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
}
