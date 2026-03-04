/**
 * Shared TypeScript Types
 */

// API Response types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// Scan result types
export type ScanResult = 
  | 'authorized'
  | 'unauthorized'
  | 'queue_empty_claim'
  | 'already_current'
  | 'machine_not_found'
  | 'user_not_found';

// Incident status
export type IncidentStatus = 
  | 'pending'
  | 'confirmed'
  | 'timeout'
  | 'dismissed';

// Incident document — FIX #6: currentUserId field added (the real owner)
export interface Incident {
  id?: string;
  machineId: string;
  intruderId: string;
  intruderName: string;
  // ownerUserId = whoever is the rightful owner (currentUserId if machine in use,
  //               nextUserId if machine free and someone else is next)
  ownerUserId: string;
  ownerUserName: string;
  // Keep legacy fields for backward compat
  nextUserId: string;
  nextUserName: string;
  status: IncidentStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  buzzerTriggered: boolean;
}

// Grace period tracking (stored in RTDB for real-time)
export interface GracePeriod {
  machineId: string;
  userId: string;
  userName: string;         // stored so admin banner can display name without extra fetch
  startedAt: string;
  expiresAt: string;        // startedAt + 5 minutes
  warningAt: string;        // startedAt + 2 minutes
  warningSent: boolean;
  status: 'active' | 'claimed' | 'expired';
  ringSilenced?: boolean;  // written by any device to stop alarm on all devices
  dismissed?: boolean;     // written by any device to close modal on all devices
}

// Usage record — FIX #7: stored in Firestore usageHistory
export interface UsageRecord {
  id?: string;
  userId: string;
  userName: string;
  machineId: string;
  startTime: string;        // ISO string
  endTime: string;          // ISO string
  duration: number;         // seconds
  resultStatus: 'Normal' | 'Unauthorized' | 'Interrupted';
  incidentId?: string | null;
}

// Machine states
export type MachineState = 
  | 'Available'
  | 'In Use'
  | 'Clothes Inside'
  | 'Unauthorized Use';

// RTDB commands structure
export interface MachineCommands {
  solenoidOpen?: {
    value: boolean;
    triggeredAt: string;
    triggeredBy: string;
    expiresAt: string;
    requestUserId?: string;
  };
  buzzer?: boolean;
  dismissAlarm?: boolean;
  tare?: boolean;
}

// Scan request body
export interface ScanRequest {
  machineId: string;
  userId: string;
  userName?: string;
}

// Release request body
export interface ReleaseRequest {
  machineId: string;
  userId: string;
  userName?: string;
}

// Incident action request body
export interface IncidentActionRequest {
  incidentId: string;
  userId: string;
  userName?: string;
  action: 'confirm_not_me' | 'dismiss' | 'timeout';
}

// Grace timeout request body
export interface GraceTimeoutRequest {
  machineId: string;
  userId: string;
  userName?: string;
  timeoutType: 'warning' | 'expired';
}

// API response for scan endpoint
export interface ScanResponse {
  success: boolean;
  result: ScanResult;
  message: string;
  data?: {
    unlocked?: boolean;
    incidentId?: string;
    currentUserId?: string | null;
    nextUserId?: string | null;
    expiresIn?: number;
    expiresAt?: string;
    nextUserName?: string;
    ownerUserName?: string;
  };
  error?: string;
}