# Claude Usage Widget — Samsung Galaxy S25 Ultra (Android)

แทนที่จะใช้ Scriptable (iOS-only) เวอร์ชัน Android ใช้ **SVG endpoint** ที่ Vercel
generate ให้ ซึ่งทุก widget app ที่โหลดรูปจาก URL ได้สามารถใช้ได้เลย

---

## ตัวเลือก Widget App (เลือกอันใดอันหนึ่ง)

### ตัวเลือก A — KWGT (แนะนำ, ฟรี)

[KWGT Kustom Widget Maker](https://play.google.com/store/apps/details?id=org.kustom.widget)
เป็น widget designer ที่ฟีเจอร์ครบที่สุดบน Android

**วิธีตั้งค่า:**

1. ติดตั้ง **KWGT** + **KWGT Pro Key** (ถ้าต้องการ bitmap URL)
2. กด long-press หน้า Home → **Widgets** → เลือก **KWGT** → วาง widget ขนาดที่ต้องการ
3. เปิด KWGT editor:
   - แตะ **+** → **Bitmap** → **Formula** (ไอคอน `fx`)
   - ใส่ URL:
     ```
     https://YOUR-APP.vercel.app/api/widget
     ```
   - ตั้ง Refresh: **15 minutes** (น้อยสุดที่ Android อนุญาต)
4. บันทึก — widget จะโหลด SVG จาก Vercel แล้วแสดงผล

> ถ้า KWGT Pro Key แพง ลองใช้ **KLWP** หรือ **Zooper Widget** แทน

---

### ตัวเลือก B — Tasker (แนะนำสำหรับคนชอบ automation, ~$3.49)

[Tasker](https://play.google.com/store/apps/details?id=net.dinglisch.android.taskerm)
สามารถ fetch JSON และ render Scene widget ได้เอง โดยไม่ต้องโหลดรูป

**Task: Fetch Claude Usage** (import XML ด้านล่าง หรือสร้างเอง)

ขั้นตอน:
1. สร้าง Task ชื่อ **Fetch Claude Usage**:
   - Action: **HTTP Request** → Method: GET → URL: `https://YOUR-APP.vercel.app/api/usage`
   - Action: **JSON Parse** → เก็บค่า `sessionPct`, `weeklyPct`, `sessionResets`, `weeklyResets`
     ลงตัวแปร `%SPCT`, `%WPCT`, `%SRESET`, `%WRESET`
   - Action: **Set Global Variable** แต่ละตัว

2. สร้าง Profile → **Time** → ทุก 15 นาที → ผูกกับ Task นี้

3. สร้าง **Scene** (UI widget):
   - แตะ Menu → **Scenes** → **+** → ตั้งชื่อ **ClaudeWidget**
   - เพิ่ม **Text** elements สำหรับ:
     - `%SPCT%` (5-hour percentage)
     - `%WPCT%` (weekly percentage)
     - `%SRESET%` / `%WRESET%` (countdown)
   - เพิ่ม **Shape** rectangle สำหรับ progress bar:
     - Width formula: `%SPCT / 100 * <bar_width>`
   - Set background color = `#111118`

4. กด long-press Home → Widgets → **Tasker** → **Scene Widget** → เลือก **ClaudeWidget**

---

### ตัวเลือก C — Webpage Widget (ง่ายที่สุด, ฟรี)

แอปที่แสดง webpage/URL เป็น widget:

- **[Hermit — Lite App Browser](https://play.google.com/store/apps/details?id=com.chimbori.hermitcrab)**
- **[Web Widget — Website Widget](https://play.google.com/store/apps/details?id=com.weebly.webwidgetapp)**

ขั้นตอน (ตัวอย่าง Hermit):
1. ติดตั้ง Hermit
2. เปิด Hermit → **+** → **Web App** → ใส่ URL:
   ```
   https://YOUR-APP.vercel.app/api/widget
   ```
3. Long-press Home → Widgets → **Hermit** → ลาก widget ลง Home Screen
4. เลือก Web App ที่สร้างไว้

---

## Samsung-specific: Always On Display

Samsung Galaxy S25 Ultra มี AOD แต่ custom widget บน AOD ทำได้จำกัดมาก
แนะนำให้วาง widget บน **Home Screen** แทน และตั้งให้ S25 Ultra
อยู่ใน **Bedtime / StandBy mode** ด้วยการ:

1. ตั้ง Samsung DeX mode หรือ
2. ใช้แอป **[StandBy for Android](https://play.google.com/store/apps/details?id=com.standby.android)**
   ซึ่งเลียนแบบ iOS StandBy mode บน Android

---

## Widget URL สรุป

| Endpoint | ใช้ทำอะไร |
|----------|-----------|
| `GET /api/widget` | SVG widget image — ใช้กับ KWGT/image widget |
| `GET /api/usage`  | JSON raw data — ใช้กับ Tasker/Automate |
| `POST /api/usage` | อัปเดตข้อมูล (Mac pusher) |

---

## ข้อจำกัด (เหมือน iPhone)

- Widget รีเฟรชทุก ~15 นาที (Android background task limit)
- ข้อมูลอัปเดตเฉพาะตอน Mac เปิด Claude Code อยู่
- ถ้า Mac ปิด ตัวเลขจะค้างค่าล่าสุด (มี "updated X ago" กำกับ)
