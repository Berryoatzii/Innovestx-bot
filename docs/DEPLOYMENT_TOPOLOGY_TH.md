# โครงสร้างการรัน AEGIS/ThaiStockBot อย่างปลอดภัย

## ข้อเท็จจริงสำคัญ

`127.0.0.1` หรือ `localhost` หมายถึง “เครื่องที่โปรแกรมนั้นกำลังรันอยู่” เสมอ ดังนั้น Netlify Function
บนคลาวด์ไม่สามารถเรียก Broker Gateway ที่เปิดอยู่บนคอม Windows ของผู้ใช้ผ่าน
`http://127.0.0.1:8787` ได้ หากตั้งค่าผิด Client จะหยุดด้วย
`LOCAL_GATEWAY_UNREACHABLE_FROM_CLOUD` ก่อนเรียกเครือข่าย

## แบบ A — ทดลอง UAT บนเครื่องเดียว (แบบที่ใช้ก่อน)

รันทุกส่วนบนคอมเดียวกัน:

1. Node/Netlify Dev รันหน้า Control Plane และ Functions ในเครื่อง
2. Python Broker Gateway รันที่ `127.0.0.1:8787`
3. Gateway เชื่อม Settrade UAT/Sandbox แบบ outbound
4. ใช้เฉพาะบัญชี UAT และคง production locks ทุกชั้นไว้

ข้อจำกัด: เมื่อคอมดับ หลับ หรืออินเทอร์เน็ตหลุด ระบบหยุดทำงาน จึงไม่ใช่โครงสร้างสำหรับเปิดเงินจริง
ตลอดเวลา และห้าม forward port 8787 ออกอินเทอร์เน็ต

## แบบ B — เปิดตลอดเวลา (ใช้ได้หลัง UAT ผ่านเท่านั้น)

ให้ Control Plane และ Broker Gateway รันร่วมกันบน VPS/private host ที่ดูแลได้ โดย:

- เก็บ API secret และ PIN ใน secret store ของเครื่องนั้น ไม่ใส่ในหน้าเว็บหรือ Git
- รับคำสั่งจากผู้ใช้ผ่านช่องทางที่พิสูจน์ตัวตนและเซ็นอนุมัติแล้ว
- Gateway ติดต่อ Settrade และ Telegram แบบ outbound
- ใช้ HTTPS, firewall/allowlist และการยืนยันตัวตนระดับเครื่องต่อเครื่องก่อนเปิด endpoint ใด ๆ
- มี service watchdog, persistent intent ledger, reconciliation และการแจ้งเตือนเมื่อสถานะไม่แน่นอน
- Stop Loss ที่โบรกเกอร์รองรับต้องถูกส่งพร้อม/ทันทีหลังคำสั่ง และระบบต้องตรวจยืนยันจากโบรกเกอร์

Bearer token อย่างเดียวไม่เพียงพอสำหรับนำ Gateway ออกสู่อินเทอร์เน็ตสาธารณะ เวอร์ชันปัจจุบันจึงต้อง
**ไม่เปิด port Gateway สาธารณะ** และยังเป็น REAL-NO-GO

## โครงสร้างเป้าหมายที่แนะนำ

แยกเว็บสาธารณะสำหรับดูข้อมูลออกจาก Worker ที่ถือสิทธิ์บัญชี:

```text
Public advisory dashboard (ไม่มี PIN/สิทธิ์ส่งคำสั่ง)
                 |
          signed approval intent
                 v
Private worker + durable queue + Broker Gateway
                 |
          outbound Settrade SDK
                 v
        UAT ก่อน แล้วจึง live pilot
```

Private worker ต้องดึงงานจาก queue แบบ outbound หรืออยู่ใน private network เดียวกับ Control Plane เพื่อไม่ต้อง
เปิด Broker Gateway ตรงสู่สาธารณะ

โครงสร้างนี้ถูกนำมาใช้ใน `private-worker-queue` และ `broker_gateway/private_worker.py` แล้ว:

1. Telegram เปลี่ยน intent เป็น `APPROVED_QUEUED` เท่านั้น ยังไม่อ้างว่าโบรกเกอร์รับคำสั่ง
2. Worker ในเครื่อง claim งานแบบ atomic และตรวจ HMAC ของรายละเอียดออเดอร์ครบทุกช่อง
3. Worker ตรวจ Production Gateway ผ่าน loopback, cash, open orders, unresolved journal และราคาใหม่
4. Control Plane บันทึก `SUBMITTING` และ one-order lifetime lock ก่อน Worker ทำ broker POST
5. Worker ส่งเลขออเดอร์และผล readback กลับ แล้ว reconcile งานเดิมก่อนรับงานใหม่เสมอ

โหมดจริงยังคง fail-closed จนกว่า release manifest, deploy commit, broker permission, pilot capital,
outage/alert drill และ human approval evidence จะผ่านครบทุกข้อ

## เกณฑ์ก่อนเงินจริง

- Settrade UAT credential พร้อม และ fault matrix ผ่านครบ
- Paper/shadow อย่างน้อย 20 วันทำการ รวมค่าธรรมเนียมและ slippage
- ทดสอบเครื่องดับ เน็ตหลุด timeout คำสั่งซ้ำ และ `EXECUTION_UNCERTAIN`
- ทุก position มีแผน exit และตรวจยืนยัน protection จากสถานะของโบรกเกอร์
- Deploy เวอร์ชันที่ตรวจแล้วได้จริง และ health/reconciliation ทำงานต่อเนื่อง
- เงินทดลองต้องซื้อ board lot ได้โดยไม่ฝ่าฝืนเพดานความเสี่ยงของพอร์ต
