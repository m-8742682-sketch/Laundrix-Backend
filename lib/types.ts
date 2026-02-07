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
  | 'authorized'           // User is currentUserId or nextUserId
  | 'unauthorized'         // User is not authorized
  | 'queue_empty_claim'    // Queue is empty, user can claim
  | 'already_current'      // User is already currentUserId
  | 'machine_not_found'    // Machine doesn't exist
  | 'user_not_found';      // User doesn't exist

// Incident status
export type IncidentStatus = 
  | 'pending'      // Waiting for nextUserId response
  | 'confirmed'    // nextUserId confirmed "not me"
  | 'timeout'      // 60s passed, no response
  | 'dismissed';   // nextUserId said "that's me" (false alarm)

// Incident document
export interface Incident {
  id?: string;
  machineId: string;
  intruderId: string;
  intruderName: string;
  nextUserId: string;
  nextUserName: string;
  status: IncidentStatus;
  createdAt: string;
  expiresAt: string;        // createdAt + 60 seconds
  resolvedAt: string | null;
  buzzerTriggered: boolean;
}

// Grace period tracking (stored in RTDB for real-time)
export interface GracePeriod {
  machineId: string;
  userId: string;
  startedAt: string;
  expiresAt: string;        // startedAt + 5 minutes
  warningAt: string;        // startedAt + 2 minutes
  warningSent: boolean;
  status: 'active' | 'claimed' | 'expired';
}

// Machine states
export type MachineState = 
  | 'Available'
  | 'In Use'
  | 'Clothes Inside'
  | 'Unauthorized Use';

// RTDB commands structure
export interface MachineCommands {
  unlock?: boolean;
  release?: boolean;
  buzzer?: boolean;
  dismissAlarm?: boolean;
  tare?: boolean;
  requestUserId?: string;
}

// Scan request body
export interface ScanRequest {
  machineId: string;
  userId: string;
}

// Release request body
export interface ReleaseRequest {
  machineId: string;
  userId: string;
}

// Incident action request body
export interface IncidentActionRequest {
  incidentId: string;
  userId: string;
  action: 'confirm_not_me' | 'dismiss' | 'timeout';
}

// Grace timeout request body
export interface GraceTimeoutRequest {
  machineId: string;
  userId: string;
  timeoutType: 'warning' | 'expired';
}
