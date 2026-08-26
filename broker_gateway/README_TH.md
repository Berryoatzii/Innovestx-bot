# Broker Gateway — Settrade SDK V2

> โครงสร้างการรันในเครื่องและบน VPS อธิบายไว้ที่
> [`docs/DEPLOYMENT_TOPOLOGY_TH.md`](../docs/DEPLOYMENT_TOPOLOGY_TH.md) โดยเฉพาะข้อจำกัดว่า
> Netlify บนคลาวด์เรียก `127.0.0.1` บนคอมผู้ใช้ไม่ได้ และห้ามเปิด port 8787 สู่สาธารณะ
>
> ขั้นตอนขอสิทธิ์ InnovestX/Settrade และสมัคร Sandbox อยู่ที่
> [`docs/OPEN_API_ACCESS_TH.md`](../docs/OPEN_API_ACCESS_TH.md)

ส่วนนี้เชื่อมบอทหุ้นไทยเดิมกับ Settrade Open API ผ่าน SDK ทางการ โดยแยก PIN
และรหัส API ออกจากหน้าเว็บ บัญชีเริ่มต้นคือ UAT/Sandbox และคำสั่งจริงถูกล็อกไว้

## ตอนนี้ทำอะไรได้

- อ่านข้อมูลบัญชี พอร์ต และคำสั่งจาก SDK ทางการ
- ส่ง Limit Order แบบ Day เท่านั้น
- จำกัดมูลค่าต่อคำสั่ง
- เขียนเลขคำขอลง SQLite **ก่อน** ติดต่อโบรกเกอร์ เพื่อกันยิงซ้ำ
- ถ้าเน็ตหลุดระหว่างส่งคำสั่ง จะขึ้น `EXECUTION_UNCERTAIN` และไม่ส่งซ้ำเอง
- ตรวจสิทธิ์ `canCancel` และอ่านสถานะกลับหลังยกเลิก
- บัญชีจริงต้องปลดล็อก 3 ชั้น และยังไม่ควรเปิดจนกว่า Sandbox ผ่านครบ

## สิ่งที่ต้องมีจากโบรกเกอร์

1. สิทธิ์ Settrade Open API สำหรับบัญชีของเจ้าของบัญชี
2. `app_id`, `app_secret`, `app_code`, เลขบัญชี และ PIN สำหรับ UAT
3. ยืนยันกับโบรกเกอร์ว่ากลยุทธ์/โปรแกรมได้รับอนุญาตตามเงื่อนไข SDK

หนึ่งชุด credential ควรล็อกอินจากโปรแกรมนี้เพียงโปรแกรมเดียว ถ้ามีโปรแกรมอื่นใช้ชุด
เดียวกัน session อาจชนกันและทำให้คำสั่งมีสถานะไม่แน่นอน

## การทดสอบของนักพัฒนา

```powershell
python -m pip install -r requirements.txt
python -m unittest -v test_gateway.py
```

## วิธีง่ายบน Windows (หลังได้รับ UAT credential)

1. คลิกขวา `setup_uat.ps1` แล้วเลือก **Run with PowerShell** เพียงครั้งแรก
2. กรอกเฉพาะข้อมูล **UAT** ที่ได้รับจาก Settrade/โบรกเกอร์
3. เปิด `start_uat.ps1` เพื่อรัน Gateway
4. เห็นข้อความ `listening on 127.0.0.1:8787` แปลว่าโปรแกรมเริ่มทำงาน แต่ยังไม่ใช่
   หลักฐานว่าเชื่อมบัญชีสำเร็จ ต้องตรวจ `/v1/health` และ account snapshot ต่อ
5. ขณะที่ Gateway เปิดอยู่ ให้เปิด `verify_uat.ps1` อีกหน้าต่างหนึ่ง ตัวตรวจนี้อ่านเฉพาะ health,
   ประเภทบัญชี เงินสด จำนวนสถานะ และจำนวนคำสั่ง โดยไม่ส่ง/แก้/ยกเลิกคำสั่งและไม่แสดงเลขบัญชี

สคริปต์จะไม่แสดง secret/PIN และสร้าง token แบบสุ่มให้เอง แต่เครื่องต้องไม่ถูกแชร์กับ
บุคคลอื่น และห้ามเปิด port 8787 ออกอินเทอร์เน็ตโดยตรง

ยังไม่ต้องกรอกข้อมูลจริงลง `.env.example` ให้คัดลอกเป็น `.env` ในเครื่องที่จะรัน
และเก็บไฟล์นั้นไว้นอก Git เท่านั้น ขั้นตอนเปิดใช้งานแบบปุ่มเดียวจะจัดทำหลังจาก
ได้ UAT credential และผ่าน fault test ครบค่ะ

## Preflight ชั้นสุดท้าย

ก่อนส่งคำสั่ง Gateway จะตรวจซ้ำว่า:

- `accountType` ตรงกับ `BROKER_REQUIRED_ACCOUNT_TYPE`
- จำนวนหุ้นเป็นเท่าของ `BROKER_BOARD_LOT`
- BUY มีเงินสดที่ตรวจยืนยันได้และเผื่อ `BROKER_CASH_BUFFER_BPS`
- SELL มีจำนวนหุ้นจริงเพียงพอในพอร์ต

Production จะไม่เริ่มทำงานหากไม่ได้กำหนด `BROKER_CASH_FIELD` และ
`BROKER_REQUIRED_ACCOUNT_TYPE` แบบตรงกับ response จริงของบัญชีค่ะ

## ตัวเฝ้า UAT เมื่อปิดเครื่องหรือเน็ตหลุด

ไฟล์ `uat_watchdog.py` เป็นตัวตรวจแบบอ่านอย่างเดียว ไม่ส่ง แก้ หรือยกเลิกคำสั่งซื้อขาย
ถ้า Gateway ปิดจริงและไม่มีโปรแกรมอื่นถือ session อยู่ ระบบจะเปิด UAT Gateway กลับเพียงหนึ่งตัว
แต่ถ้ามีพอร์ต คำสั่งค้าง รายการที่ต้องกระทบยอด หรือพอร์ตเปิดแต่ Gateway ไม่ตอบ ระบบจะแจ้งเตือนและไม่เดาสถานะ

ติดตั้งงานตรวจทุก 5 นาทีและตอนล็อกอินด้วย `install_uat_watchdog_task.ps1`
แล้วดูผลล่าสุดด้วย `show_uat_watchdog_status.ps1` งานนี้ถูกล็อกให้ใช้ได้เฉพาะ
`BROKER_ENVIRONMENT=uat`, `BROKER_PRODUCTION_ENABLED=false` และ Gateway บน loopback เท่านั้น

การเปิด Gateway กลับไม่ได้แปลว่าอนุญาตให้ซื้อขาย และไม่ได้ทำให้ Stop Loss ฝั่งเครื่องกลายเป็น
คำสั่งคุ้มครองฝั่งโบรกเกอร์ บัญชีเงินจริงยังคง `REAL-NO-GO` จนกว่าการทดสอบ outage/reconciliation
และข้อกำหนดโบรกเกอร์จะผ่านครบ

## Private Worker สำหรับเงินจริง

`private_worker.py` แก้ข้อจำกัดที่ Netlify เรียก `localhost` ไม่ได้ โดยเครื่องนี้เป็นฝ่ายดึง
intent ที่ผู้ใช้อนุมัติแล้วจาก `private-worker-queue` ผ่าน HTTPS จากนั้นจึงตรวจบัญชี ราคา
ออเดอร์ค้าง และ journal ในเครื่องอีกครั้ง ไม่เปิดพอร์ต Gateway สู่สาธารณะ

- ค่าเริ่มต้นเป็น dry-run: ไม่ claim คิวและไม่มี POST ไปยังโบรกเกอร์
- intent ต้องเป็น `RESTING_LIMIT` และลายเซ็นต้องผูกกับ symbol/side/quantity/price/expiry ครบ
- ก่อน POST ต้องบันทึก `SUBMITTING` ในคิวแบบ strong consistency และจอง one-order pilot lock
- หาก transport ขาดหลัง POST จะเป็น `EXECUTION_UNCERTAIN` และห้ามส่งซ้ำ
- ทุกครั้งถัดไป Worker จะ reconcile ออเดอร์เดิมก่อน claim งานใหม่

ติดตั้งตัวตรวจ read-only ทุก 5 นาทีได้ด้วย `install_private_worker_dry_run_task.ps1` งานนี้ใช้
`.env.production-readonly` เท่านั้น จึงไม่สามารถ claim หรือส่งออเดอร์ได้ ส่วนตัวอย่างค่าของ Worker
จริงอยู่ที่ `production-pilot.env.example`; ห้ามเปิด flags ในไฟล์จริงจนกว่า Operational Pilot
evidence จะผ่านครบ

## ดูแผนออเดอร์ UAT ก่อนส่ง

ใช้คำสั่งนี้เพื่ออ่านราคาและสร้างแผน Limit Order จำลอง โดยยังไม่ส่งคำสั่ง:

```powershell
.\show_uat_order_plan.ps1 PTT
```

ผลลัพธ์ต้องแสดง `mutationAuthorized=false` คำสั่งนี้ใช้เฉพาะ `GET` ไม่ต้องใช้
`SEND_UAT_ORDER_ONLY` และไม่สร้างออเดอร์ UAT หรือเงินจริง
