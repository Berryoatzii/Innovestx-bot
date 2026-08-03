# คู่มือใช้งาน Investment Bot สำหรับโอ๊ด

## บอททำงานอย่างไร

1. อ่านพอร์ตจริงจาก InnovestX / Settrade แบบ Read-only
2. ให้โอ๊ดกดจัดหุ้นเป็น CORE, ACTIVE หรือ REVIEW ผ่าน Telegram
3. CORE ตรวจงบ + ปันผล + Thesis แต่ไม่ขายอัตโนมัติ
4. ACTIVE รัน Backtest และพอร์ตเงาตามกฎที่เขียนตายตัว
5. เมื่อ Backtest และ Shadow ผ่าน ระบบจึงสร้าง Order Proposal
6. โอ๊ดกดอนุมัติหรือปฏิเสธ
7. หลังอนุมัติ ระบบตรวจพอร์ต ราคา Spread เงินสด วันหยุด ออเดอร์ซ้ำ และวงเงินอีกครั้ง
8. ผ่านครบจึงส่ง Limit Order และติดตามสถานะกับโบรกเกอร์

## คำสั่ง Telegram

- `/setup` — อ่านพอร์ตและส่งปุ่มให้จัดหมวดหุ้น
- `/portfolio` — ดูหุ้นแต่ละตัวว่าอยู่ CORE / ACTIVE / REVIEW
- `/readiness` — ดูว่ายังติดขั้นตอนไหน
- `/backtest` — ทดสอบกฎ ACTIVE หลังค่าธรรมเนียมและ Slippage
- `/shadow` — อัปเดตพอร์ตเงาแบบ Rules-only
- `/core` — ตรวจ Fundamental Snapshot และ Thesis ของ CORE
- `/pending` — ดู Order Intent ที่รออนุมัติ

## ความหมายของแต่ละหมวด

### CORE
หุ้นถือยาวหลายปี เน้นคุณภาพธุรกิจ ปันผล และราคาที่มี Margin of Safety

- ห้ามขายจากสัญญาณรายชั่วโมง
- ห้ามถัวเพราะราคาลงอย่างเดียว
- ต้องมี Fundamental Snapshot ที่สด
- ต้องมี Thesis Card ที่โอ๊ดอนุมัติ

### ACTIVE
หุ้น Swing ระดับวันถึงเดือน

- ใช้ Rules-only Strategy
- ต้องผ่าน Backtest หลังต้นทุน
- ต้องผ่าน Shadow อย่างน้อย 20 วันและ 100 Decision Events
- ทุกออเดอร์ต้องให้โอ๊ดอนุมัติ

### REVIEW
หุ้นที่ยังไม่ควรซื้อขาย

- ใช้เมื่อข้อมูลไม่ครบ
- ใช้เมื่อโอ๊ดยังไม่แน่ใจว่าเป็น CORE หรือ ACTIVE
- ไม่มีสิทธิ์สร้าง Order Proposal

## Safe Defaults

ค่าต่อไปนี้ต้องปิดไว้ระหว่าง Setup และ Shadow:

```text
LIVE_TRADING_ENABLED=false
HUMAN_APPROVAL_LIVE_ENABLED=false
SCHEDULED_TRADE_MODE=dry_run
```

ค่า Telegram และ Security ที่ต้องมี:

```text
TELEGRAM_TOKEN
TELEGRAM_CHAT_ID
TELEGRAM_APPROVER_USER_ID
TELEGRAM_WEBHOOK_SECRET
ADMIN_TOKEN
EXECUTE_CONFIRMATION
ORDER_INTENT_GATE_SECRET
ALLOWED_ORIGIN
```

ค่า InnovestX / Settrade:

```text
INVX_KEY
INVX_SECRET
INVX_PIN
INVX_ACCOUNT
```

## Limited Live Pilot

เปิดได้หลัง `/readiness` แสดงว่าผ่าน Proposal Gate แล้วเท่านั้น

เริ่มต้นแนะนำ:

```text
MAX_LIVE_ORDER_VALUE=1000
MAX_DAILY_APPROVED_ORDERS=1
MAX_DAILY_APPROVED_NOTIONAL=1000
MAX_LIVE_ACTIVE_POSITION_WEIGHT=0.03
MAX_LIVE_POSITION_FRACTION=0.20
MIN_LIVE_CASH_RESERVE=5000
MAX_SPREAD_PCT=0.02
MAX_PRICE_DRIFT_PCT=0.015
```

จากนั้นจึงเปิดสองชั้น:

```text
LIVE_TRADING_ENABLED=true
HUMAN_APPROVAL_LIVE_ENABLED=true
```

การเปิดสองค่านี้ไม่ได้ทำให้บอทเทรดเอง ทุก Order ยังต้องมี Rules Intent และโอ๊ดกดอนุมัติใน Telegram

## สิ่งที่ห้ามทำ

- ห้ามใส่ Secret ในหน้าเว็บหรือส่งในแชตสาธารณะ
- ห้ามกดอนุมัติซ้ำหากสถานะเป็น RECONCILE_PENDING
- ห้ามเปิด Live หาก `/readiness` ยังมี Blocker
- ห้ามนำราคาแนะนำปี 2568 มาใช้เป็นราคาซื้อปัจจุบัน
- ห้ามใช้เงินค่าใช้จ่ายครอบครัวหรือเงินกู้
