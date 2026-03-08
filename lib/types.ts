// ─── Grace Period ──────────────────────────────────────────────────────────────

export interface GracePeriod {
  machineId: string;
  userId: string;
  userName: string;
  startedAt: string;
  expiresAt: string;
  warningAt: string;
  warningSent: boolean;
  status: 'active' | 'claimed' | 'expired';
}

// ─── Usage record ──────────────────────────────────────────────────────────────

export interface UsageRecord {
  id?: string;
  userId: string;
  userName: string;
  machineId: string;
  startTime: string;
  endTime: string;
  duration: number;
  resultStatus: 'Completed' | 'Unauthorized' | 'Timeout';
  incidentId?: string | null;
}

// ─── Incident ──────────────────────────────────────────────────────────────────

export interface Incident {
  machineId: string;
  intruderId: string;
  intruderName: string;
  ownerUserId: string;
  ownerUserName: string;
  nextUserId: string;       // backward compat alias for ownerUserId
  nextUserName: string;
  status: 'pre_pending'|'pending' | 'confirmed' | 'resolved' | 'dismissed' | 'timeout';
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  buzzerTriggered: boolean;
}

// ─── Incident action request ───────────────────────────────────────────────────
// action values MUST match exactly what the frontend sends (api.ts + useIncidentHandler.ts)

export interface IncidentActionRequest {
  incidentId: string;
  userId: string;
  action: 'thats_me'|'admin_dismiss'|'admin_dismiss_false'|'confirm' | 'confirm_not_me' | 'dismiss' | 'timeout';
  cancelReason?: string;
}

// ─── Scan ──────────────────────────────────────────────────────────────────────

export interface ScanRequest {
  machineId: string;
  userId: string;
  userName?: string;
}

export interface ScanResponse {
  success: boolean;
  result: ScanResult;
  message: string;
  data?: any;
}

export type ScanResult =
  | 'authorized'
  | 'already_current'
  | 'queue_empty_claim'
  | 'unauthorized'
  | 'machine_not_found'
  | 'user_not_found';

// ─── Release request ──────────────────────────────────────────────────────────

export interface ReleaseRequest {
  machineId: string;
  userId: string;
}

// ─── Grace timeout request ────────────────────────────────────────────────────

export interface GraceTimeoutRequest {
  machineId: string;
  userId: string;
  timeoutType: 'warning' | 'expired';
}

// ─── Generic API response ─────────────────────────────────────────────────────

export interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  error?: string;
  data?: T;
}
