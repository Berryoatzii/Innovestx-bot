# ขอสิทธิ์ Open API สำหรับ InnovestX อย่างถูกต้อง

ตรวจสอบวันที่ 5 สิงหาคม 2569 จากเอกสารทางการของ Settrade และ InnovestX

## ข้อสรุป

- InnovestX ใช้รหัสโบรกเกอร์ `023` และอยู่ในรายชื่อผู้ให้บริการ Settrade Open API สำหรับหุ้น
- ระบบจริงใช้ `settrade-v2==2.2.1`
- ก่อนระบบจริงต้องสมัครและทดสอบ Settrade Sandbox/UAT
- ห้ามส่ง App Secret, PIN, API key หรือเลขบัญชีในแชต ให้กรอกเฉพาะใน `setup_uat.ps1`

## ขั้นตอนของเจ้าของบัญชี

### 1. สมัคร Sandbox

1. เปิดหน้าลงทะเบียน Sandbox: <https://developer.settrade.com/open-api/register>
2. ลงทะเบียน/เข้าสู่ระบบและยอมรับ SDK disclaimer
3. สร้าง UAT App ID และ App Secret ตามข้อมูลจำลองที่ระบบให้
4. เก็บ UAT account number และ PIN ไว้ในเครื่องส่วนตัว

Sandbox เป็นข้อมูลจำลองเท่านั้น ใช้พิสูจน์การเชื่อมต่อ คำสั่งซ้ำ partial fill การยกเลิก และการกู้คืน
ไม่ใช้ผลกำไรจาก Sandbox ตัดสินว่ากลยุทธ์ทำกำไรจริง

### 2. ติดตั้งและตรวจแบบไม่ส่งคำสั่ง

1. รัน `broker_gateway/setup_uat.ps1` แล้วกรอกเฉพาะ UAT credential
2. รัน `broker_gateway/check_uat.ps1` เพียงไฟล์เดียว สคริปต์จะเปิด Gateway แบบซ่อน ตรวจบัญชี
   และแสดงพอร์ต UAT แบบไม่มีเลขบัญชีให้เอง
3. ต้องเห็น `UAT READ-ONLY CHECK: PASS`, `Environment: uat` และรายงานพอร์ต UAT

ตัวตรวจจะไม่เรียก endpoint ส่ง แก้ หรือยกเลิกคำสั่ง และไม่พิมพ์เลขบัญชี/credential

### 3. ทดสอบคำสั่งจำลอง

เริ่มจาก `broker_gateway/run_uat_order_test.ps1` ซึ่งรับเฉพาะ UAT ในเครื่องและต้องพิมพ์
`SEND_UAT_ORDER_ONLY` ให้ตรงทุกตัวอักษร สคริปต์จะทดสอบ Limit order, ส่ง request เดิมซ้ำเพื่อพิสูจน์
idempotency, อ่านสถานะกลับ และยกเลิกเมื่อคำสั่งยังยกเลิกได้ พร้อมเก็บหลักฐานที่ไม่มีข้อมูลลับไว้ใน
`broker_gateway/uat_evidence/` ผลไฟล์นี้ไม่ถูกนำเข้า Git

สำหรับรอบทดสอบแรกให้ใช้ `broker_gateway/run_uat_passive_order_test.ps1` แทน สคริปต์จะเลือก BUY
หนึ่ง board lot ที่ราคา floor จาก UAT หรือสิบ tick ใต้ best bid เมื่อ Sandbox ไม่ส่ง floor โดยอ่าน bid/ask ผ่าน
RealtimeDataConnection ใน session เดิม และตรวจข้อมูล/ราคาเดิมซ้ำก่อนส่ง หากราคาเปลี่ยนจนมีโอกาสจับคู่
หรือข้อมูลใดหาย ระบบจะหยุดก่อนเรียก endpoint ส่งคำสั่ง

จากนั้นทำกรณีที่เหลือตาม `docs/SETTRADE_UAT_FAULT_MATRIX.md` และเก็บ request ID, เวลา, ผลจาก SDK และภาพจาก Sandbox
โดยเฉพาะ timeout, session reset, login ซ้อน, partial fill, cancel และโปรแกรมดับกลางคำสั่ง

### 4. ขอ Production key หลัง UAT ผ่าน

Settrade ระบุให้ล็อกอิน Streaming ด้วย username จากโบรกเกอร์ แล้วไป `More` → `API Key Management` →
`Generate` เพื่อสร้าง App ID/App Secret ระบบจริง การเปิด Production ในบอทยังต้องผ่านตัวล็อกสามชั้นและ
human approval ทุกคำสั่ง

## เรื่อง session ที่ระบบต้องดูแล

- Settrade reset session ทุกวันประมาณ 03:00–04:00 และต้อง login ใหม่
- credential ชุดเดียวใช้พร้อมกันได้เพียงโปรแกรมเดียว การ login ซ้อนทำให้ session เดิมใช้ไม่ได้
- บอทจึงต้องเป็นเจ้าของ session เพียง process เดียว และคำสั่ง mutation ที่เจอ 401/timeout ห้าม retry อัตโนมัติ

## ทำไมยังไม่ใช้ InnovestX TradingView webhook เป็นเส้นหลัก

InnovestX WebTrade รองรับ webhook อัตโนมัติสำหรับลูกค้าแผน Essential ขึ้นไป บัญชีหุ้นไทยต้องเป็น Cash
Balance และ board lot ขั้นต่ำ 100 หุ้น แต่เส้นทางนี้เป็น endpoint ที่ผูกกับบัญชีจริง จึงไม่ทดแทน Sandbox,
account reconciliation และ durable order ledger ของระบบนี้ อาจใช้เป็นช่องทางสำรองในอนาคตหลังผ่าน UAT
เท่านั้น

## แหล่งข้อมูลทางการ

- Settrade Open API overview/ขั้นตอนสร้าง key: <https://developer.settrade.com/open-api/document>
- รายชื่อโบรกเกอร์ (INVX 023): <https://developer.settrade.com/open-api/document/broker-list>
- ลงทะเบียน Sandbox: <https://developer.settrade.com/open-api/register>
- Python SDK รุ่นปัจจุบัน: <https://developer.settrade.com/open-api/api-reference>
- Equity Limit/Day order: <https://developer.settrade.com/open-api/api-reference/reference/sdkv2/python/investor-equity/8_placeOrder>
- การจัดการ session: <https://developer.settrade.com/open-api/document/reference/sdkv2/info/sessionManagement>
- คู่มือ InnovestX TradingView webhook: <https://www.innovestx.co.th/docs/default-source/webtrade/webhook_manual.pdf?sfvrsn=6ddb8067_1>
