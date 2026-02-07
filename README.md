# Laundrix Backend API

Serverless backend for the Laundrix IoT laundry machine tracking system.
Deployed on Vercel (100% free tier).

## 🚀 Quick Start

### 1. Prerequisites

- [Node.js 18+](https://nodejs.org/)
- [Vercel CLI](https://vercel.com/cli): `npm i -g vercel`
- Firebase project with service account

### 2. Clone and Install

```bash
cd laundrix-backend
npm install
```

### 3. Get Firebase Service Account

1. Go to [Firebase Console](https://console.firebase.google.com/) → Project Settings → Service Accounts
2. Click "Generate new private key"
3. Save the JSON file (keep it secret!)

### 4. Configure Environment Variables

Create a `.env.local` file for local development:

```env
FIREBASE_PROJECT_ID=laundrix-f6591
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@laundrix-f6591.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_DATABASE_URL=https://laundrix-f6591-default-rtdb.asia-southeast1.firebasedatabase.app
```

**Important:** The private key must include the `\n` characters and be wrapped in quotes.

### 5. Run Locally

```bash
vercel dev
```

Server runs at `http://localhost:3000`

### 6. Deploy to Vercel

```bash
# Login to Vercel (first time only)
vercel login

# Deploy to preview
vercel

# Deploy to production
vercel --prod
```

### 7. Set Production Environment Variables

```bash
vercel env add FIREBASE_PROJECT_ID
vercel env add FIREBASE_CLIENT_EMAIL
vercel env add FIREBASE_PRIVATE_KEY
vercel env add FIREBASE_DATABASE_URL
```

Or set them in the Vercel Dashboard → Project → Settings → Environment Variables

---

## 📡 API Endpoints

### Health Check
```
GET /api/health
```

### QR Code Scan
```
POST /api/scan
Body: { machineId: "M001", userId: "user123" }
```

### Release Machine (End Session)
```
POST /api/release
Body: { machineId: "M001", userId: "user123" }
```

### Join Queue
```
POST /api/join-queue
Body: { machineId: "M001", userId: "user123" }
```

### Leave Queue
```
POST /api/leave-queue
Body: { machineId: "M001", userId: "user123" }
```

### Incident Actions (Unauthorized Access)
```
POST /api/incident-action
Body: { 
  incidentId: "incident123", 
  userId: "user123", 
  action: "confirm_not_me" | "dismiss" | "timeout" 
}
```

### Grace Period Timeout
```
POST /api/grace-timeout
Body: { 
  machineId: "M001", 
  userId: "user123", 
  timeoutType: "warning" | "expired" 
}
```

### Claim Grace Period
```
POST /api/claim-grace
Body: { machineId: "M001", userId: "user123" }
```

### Dismiss Alarm
```
POST /api/dismiss-alarm
Body: { machineId: "M001", userId: "user123" }
```

---

## 🔄 Flow Diagrams

### Normal Flow: Claiming Machine

```
User scans QR
    │
    ▼
POST /api/scan
    │
    ├─▶ User is currentUserId? → Unlock door, return success
    │
    ├─▶ User is nextUserId? → Remove from queue, set as current, unlock
    │
    ├─▶ Queue empty? → Set as current, unlock
    │
    └─▶ Unauthorized → Create incident, notify both users
```

### Grace Period Flow

```
currentUserId releases machine
    │
    ▼
POST /api/release
    │
    ▼
Notify nextUserId (alarm sound)
    │
    ▼
Start 5-min grace period
    │
    ├─▶ nextUserId scans within 5 min
    │       │
    │       ▼
    │   POST /api/scan → Success, clear grace period
    │
    ├─▶ 2 min passes (no scan)
    │       │
    │       ▼
    │   POST /api/grace-timeout (warning)
    │   → Send "Hurry up!" notification
    │
    └─▶ 5 min passes (no scan)
            │
            ▼
    POST /api/grace-timeout (expired)
    → Remove from queue, notify next user
```

### Unauthorized Access Flow

```
Unauthorized user scans QR
    │
    ▼
POST /api/scan → Returns incidentId
    │
    ├─▶ Intruder receives warning notification
    │
    └─▶ nextUserId receives alarm: "Someone at your machine!"
            │
            ▼
    ┌───────┴───────┐
    │               │
    ▼               ▼
"Not me" tap    60s timeout
    │               │
    ▼               ▼
POST /api/incident-action (confirm_not_me | timeout)
    │
    ▼
Trigger buzzer on ESP32
```

---

## 📱 React Native Integration

### API Service Example

```typescript
// services/api.ts
const API_BASE = 'https://your-app.vercel.app';

export const LaundrixAPI = {
  async scan(machineId: string, userId: string) {
    const response = await fetch(`${API_BASE}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machineId, userId }),
    });
    return response.json();
  },

  async release(machineId: string, userId: string) {
    const response = await fetch(`${API_BASE}/api/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machineId, userId }),
    });
    return response.json();
  },

  async handleIncident(incidentId: string, userId: string, action: string) {
    const response = await fetch(`${API_BASE}/api/incident-action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ incidentId, userId, action }),
    });
    return response.json();
  },

  async graceTimeout(machineId: string, userId: string, timeoutType: string) {
    const response = await fetch(`${API_BASE}/api/grace-timeout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machineId, userId, timeoutType }),
    });
    return response.json();
  },
};
```

### QR Scan Handler Example

```typescript
// screens/QRScan.tsx
const handleQRScan = async (data: string) => {
  const machineId = data; // QR contains machine ID e.g., "M001"
  const userId = auth().currentUser?.uid;

  const result = await LaundrixAPI.scan(machineId, userId);

  if (result.success) {
    // Door unlocked!
    showToast('Door unlocked! 🎉');
    navigation.navigate('MachineStatus', { machineId });
  } else if (result.result === 'unauthorized') {
    // Show warning
    showAlert('Not Your Turn', result.message);
  }
};
```

### Grace Period Countdown Example

```typescript
// components/GracePeriodCountdown.tsx
const GracePeriodCountdown = ({ machineId, userId, expiresAt }) => {
  const [secondsLeft, setSecondsLeft] = useState(300); // 5 minutes

  useEffect(() => {
    const interval = setInterval(() => {
      const remaining = Math.max(0, 
        Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)
      );
      setSecondsLeft(remaining);

      // Send warning at 2 minutes
      if (remaining === 180) {
        LaundrixAPI.graceTimeout(machineId, userId, 'warning');
      }

      // Send expired at 0
      if (remaining === 0) {
        LaundrixAPI.graceTimeout(machineId, userId, 'expired');
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [expiresAt]);

  return (
    <View>
      <Text>Time remaining: {Math.floor(secondsLeft / 60)}:{(secondsLeft % 60).toString().padStart(2, '0')}</Text>
    </View>
  );
};
```

### Incident Alert Example

```typescript
// components/IncidentAlert.tsx
const IncidentAlert = ({ incidentId, machineId, intruderName, expiresAt }) => {
  const userId = auth().currentUser?.uid;
  const [secondsLeft, setSecondsLeft] = useState(60);

  useEffect(() => {
    const interval = setInterval(() => {
      const remaining = Math.max(0,
        Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)
      );
      setSecondsLeft(remaining);

      if (remaining === 0) {
        // Auto-timeout
        LaundrixAPI.handleIncident(incidentId, userId, 'timeout');
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [expiresAt]);

  const handleNotMe = async () => {
    await LaundrixAPI.handleIncident(incidentId, userId, 'confirm_not_me');
    // Buzzer will ring
  };

  const handleThatsMe = async () => {
    await LaundrixAPI.handleIncident(incidentId, userId, 'dismiss');
    // Scan was actually them, dismiss
  };

  return (
    <Modal visible={true}>
      <Text>🚨 Someone at your machine!</Text>
      <Text>{intruderName} is trying to use Machine {machineId}</Text>
      <Text>Responding in: {secondsLeft}s</Text>
      <Button onPress={handleThatsMe}>That's me ✓</Button>
      <Button onPress={handleNotMe}>Not me ✗</Button>
    </Modal>
  );
};
```

---

## 🔔 FCM Setup for Lock Screen Notifications

### 1. Add to React Native App

```bash
npm install @react-native-firebase/messaging
```

### 2. Configure Android Channel

```java
// android/app/src/main/java/.../MainApplication.java
import android.app.NotificationChannel;
import android.app.NotificationManager;

// In onCreate():
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
    NotificationChannel urgentChannel = new NotificationChannel(
        "urgent_alerts",
        "Urgent Alerts",
        NotificationManager.IMPORTANCE_HIGH
    );
    urgentChannel.setDescription("Urgent laundry alerts");
    urgentChannel.enableVibration(true);
    urgentChannel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
    
    NotificationManager manager = getSystemService(NotificationManager.class);
    manager.createNotificationChannel(urgentChannel);
}
```

### 3. Store FCM Token in Firestore

```typescript
// App.tsx
import messaging from '@react-native-firebase/messaging';

useEffect(() => {
  const getToken = async () => {
    const token = await messaging().getToken();
    const userId = auth().currentUser?.uid;
    
    if (userId) {
      await firestore().collection('users').doc(userId).update({
        fcmToken: token,
      });
    }
  };

  getToken();

  // Listen for token refresh
  return messaging().onTokenRefresh(token => {
    const userId = auth().currentUser?.uid;
    if (userId) {
      firestore().collection('users').doc(userId).update({ fcmToken: token });
    }
  });
}, []);
```

---

## 📁 Project Structure

```
laundrix-backend/
├── api/
│   ├── scan.ts              # QR scan verification
│   ├── release.ts           # End session
│   ├── join-queue.ts        # Join queue
│   ├── leave-queue.ts       # Leave queue
│   ├── incident-action.ts   # Handle unauthorized incidents
│   ├── grace-timeout.ts     # Grace period timeouts
│   ├── claim-grace.ts       # Claim during grace period
│   ├── dismiss-alarm.ts     # Dismiss buzzer
│   └── health.ts            # Health check
├── lib/
│   ├── firebase.ts          # Firebase Admin SDK init
│   ├── fcm.ts               # Push notification helpers
│   ├── queue.ts             # Queue management
│   └── types.ts             # TypeScript types
├── package.json
├── tsconfig.json
├── vercel.json
└── README.md
```

---

## 🔐 Security Notes

1. **Service Account**: Never commit the Firebase service account JSON to git
2. **Environment Variables**: Use Vercel's encrypted environment variables
3. **User Verification**: All endpoints should verify userId matches the authenticated user
4. **Rate Limiting**: Consider adding rate limiting for production

---

## 📝 License

MIT
