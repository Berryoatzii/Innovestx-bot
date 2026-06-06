# Claude Usage Widget

แสดง Claude Code usage (5-hour & weekly) บน widget หน้าจอ — รองรับทั้ง **iPhone** (Scriptable) และ **Android/Samsung** (KWGT, Tasker, หรือ Webpage Widget)

Widget ที่ได้:

```
┌────────────────────────────────────────────────┐
│  [pixel art]   │  CLAUDE USAGE              ●  │
│   character    │                                │
│                │  5-hour              25%       │
│   vibing       │  resets in 1h 39m             │
│  5h 25% 7d 41% │  ════════░░░░░░░░░░░░░░░░      │
│                │                                │
│                │  Weekly              41%       │
│                │  resets in 4h 19m             │
│                │  ══════════════░░░░░░░░░       │
│                │                                │
│                │  updated 2m ago               │
└────────────────────────────────────────────────┘
```

---

## Requirements

| ส่วนประกอบ | รายละเอียด |
|-----------|-----------|
| Claude Code | v2.1.80+ (แพ็กเกจ Pro หรือ Max) |
| Mac | รัน Claude Code + Node.js |
| Vercel account | ฟรี — host API endpoint |
| Vercel KV | ฟรีเทียร์ — เก็บข้อมูล usage |
| Widget app | iPhone: Scriptable / Android: KWGT, Tasker, หรือ Webpage Widget |

---

## Setup (ทำครั้งเดียว)

### 1. Deploy ขึ้น Vercel

```bash
npm i -g vercel
vercel deploy --prod
```

> ครั้งแรก Vercel จะถามชื่อ project และ account — ตอบตามปกติ

### 2. สร้าง Vercel KV Database

1. ไปที่ [vercel.com](https://vercel.com) → Dashboard → project ของคุณ
2. **Storage** tab → **Create Database** → เลือก **KV (Redis)**
3. ตั้งชื่อ (เช่น `claude-widget-kv`) → **Create & Continue**
4. Vercel จะเพิ่ม env vars (`KV_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`) ให้อัตโนมัติ

### 3. ตั้งค่า API Token

ใน Vercel project → **Settings** → **Environment Variables** → เพิ่ม:

```
API_TOKEN = <random-secret-string>
```

สร้าง random token ได้ด้วย:
```bash
openssl rand -hex 32
```

### 4. ติดตั้ง Mac Pusher

```bash
chmod +x mac-pusher/push-usage.sh mac-pusher/install.sh

# ทดสอบก่อน
CLAUDE_WIDGET_URL=https://your-app.vercel.app \
CLAUDE_WIDGET_TOKEN=your-token \
bash mac-pusher/push-usage.sh

# ติดตั้ง LaunchAgent (run ทุก 5 นาที)
CLAUDE_WIDGET_URL=https://your-app.vercel.app \
CLAUDE_WIDGET_TOKEN=your-token \
bash mac-pusher/install.sh
```

### 5. ตั้งค่า Widget

- **iPhone (Scriptable)**: ดูโพสต์ต้นฉบับ — ใช้ `GET /api/usage` เพื่อดึง JSON แล้ว render ใน Scriptable
- **Android/Samsung**: ดู [`android/SETUP_ANDROID.md`](android/SETUP_ANDROID.md)

---

## API Endpoints

### `GET /api/usage`
คืน JSON ข้อมูล usage ล่าสุด:
```json
{
  "sessionPct": 25,
  "weeklyPct": 41,
  "sessionResets": "1h 39m",
  "weeklyResets": "4h 19m",
  "updatedAt": "2025-01-01T12:00:00.000Z"
}
```

### `GET /api/widget`
คืน SVG widget image (dark theme, pixel art character) — ใช้กับ KWGT หรือ image-URL widget app บน Android

### `POST /api/usage`
Header: `Authorization: Bearer <API_TOKEN>`  
Body: JSON เหมือน GET response ด้านบน (ไม่มี `updatedAt`)

---

## Widget Character

ตัวละคร pixel art เปลี่ยนหน้าตาตาม usage level:

| Usage | สถานะ | หน้าตา |
|-------|-------|--------|
| 0–9%  | chilling  | ปกติ |
| 10–39% | vibing   | ยิ้ม |
| 40–69% | grinding | ยิ้มกว้าง |
| 70–89% | heavy load | ง่วง |
| 90–100% | maxed out | ตาไขว้ |

---

## ข้อจำกัด

- ข้อมูลอัปเดตเฉพาะตอน Mac เปิด Claude Code (ไม่ใช่ real-time ตลอด 24 ชม.)
- Widget รีเฟรชตาม OS budget: ~15–60 นาที บน iOS / ~15 นาที บน Android
- แสดงเฉพาะ session (5h) + weekly รวมทุกโมเดล

---

## License

MIT — ดัดแปลงได้เสรี
