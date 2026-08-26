# แผนเมื่อเน็ตหลุด เครื่องดับ หรือคำสั่งค้าง

## คำตอบสั้นที่สุด

- คำสั่งที่โบรกเกอร์ **รับและให้เลข order แล้ว** จะอยู่ที่ระบบโบรกเกอร์ ไม่หายเพราะคอมดับ
- คำสั่ง Equity แบบ `Day` ที่ยังไม่จับคู่จะมีผลเฉพาะวันส่งคำสั่ง
- หุ้นที่ซื้อจับคู่แล้วจะยังอยู่ในบัญชี แต่บอทจะดูแลต่อไม่ได้ระหว่างเครื่อง/เน็ตดับ
- ห้ามเดาว่าคำสั่งสำเร็จหรือล้มเหลวเมื่อ timeout; สถานะนั้นคือ `EXECUTION_UNCERTAIN`
- เมื่อระบบกลับมา ต้องอ่าน Portfolio + Orders จากโบรกเกอร์และกระทบยอดก่อนส่งคำสั่งใหม่เสมอ

## ข้อจำกัดที่ต้องรู้ก่อนเงินจริง

Settrade SDK V2 สำหรับ Equity มีคำสั่ง Limit/ATO/ATC/MP-MTL/MP-MKT และ
Validity Day/FOK/IOC/Date/Cancel แต่ signature ของ Equity ไม่มี `stopCondition`
หรือ `stopPrice` แบบ Derivatives ดังนั้น AEGIS จะ **ไม่อ้างว่ามี Stop Loss ฝั่งโบรกเกอร์**
จนกว่าจะยืนยันช่องทาง Conditional Order สำหรับบัญชีหุ้นไทยของผู้ใช้ได้จริงใน UAT/บัญชีจริง

เอกสารทางการ:

- [Equity place_order (SDK V2)](https://developer.settrade.com/open-api/api-reference/reference/sdkv2/python/investor-equity/8_placeOrder)
- [Order Condition](https://developer.settrade.com/open-api/document/reference/sdkv2/info/placeOrderCondition)
- [Session Management](https://developer.settrade.com/open-api/document/reference/sdkv2/info/sessionManagement)

## สิ่งที่ระบบทำอัตโนมัติเมื่อกลับมา

1. เปิด Gateway และตรวจ environment ให้ตรง (`uat` หรือ `prod`)
2. อ่าน `/v1/journal/unresolved` ก่อน หากมี `SUBMITTING` หรือ `EXECUTION_UNCERTAIN`
   ตัวตรวจ `check_uat.ps1` จะแจ้งเตือนและห้ามถือว่าคำสั่งล้มเหลว Journal เก็บเฉพาะ
   symbol, side, quantity, price หรือเลขคำสั่งที่ยกเลิก ไม่เก็บ PIN/Secret/Token
3. อ่านสถานะคำสั่งจาก `/v1/orders` โดยไม่ส่งคำสั่งใหม่
4. เทียบ `request_id`, symbol, side, quantity, price และช่วงเวลาใน durable journal
5. ถ้าพบคำสั่งเดียวที่ตรงกัน จึงผูกเลข order และติดตามต่อ
6. ถ้าไม่พบ หรือพบมากกว่าหนึ่งคำสั่ง ให้หยุด mutation และแจ้งผู้ใช้ตรวจใน Streaming
7. ตรวจ Portfolio/เงินสดใหม่ก่อนสร้าง intent รอบถัดไป

## ผู้ใช้ต้องทำอะไรเมื่อเห็นคำเตือน

1. เปิด Streaming > Orders เพื่อตรวจ `Working / Matched / Partial / Rejected / Cancelled`
2. ห้ามกดส่งซ้ำเพียงเพราะหน้า AEGIS ไม่ตอบ
3. ถ้ามี Partial Fill ให้ตรวจจำนวนที่จับคู่จริงและยอดหุ้นใน Portfolio
4. ถ้าตลาดเปิดและความเสี่ยงเกินแผน ให้จัดการผ่านช่องทางโบรกเกอร์ที่ใช้งานได้
5. เก็บภาพเลข order และเวลา แล้วหยุด AEGIS จน reconciliation ผ่าน

## เกณฑ์ก่อนเปิดเงินจริง

- UAT ผ่านกรณี timeout ก่อน/หลัง broker รับคำสั่ง, process crash, duplicate key,
  partial fill, reject, cancel-not-confirmed และ session conflict
- ทดสอบ session reset ช่วง 03:00–04:00 และยืนยันว่า read reconnect ได้ แต่ mutation ไม่ replay
- มี private worker/VPS ที่มี watchdog; ห้ามเปิด port Gateway ตรงสู่สาธารณะ
- ถ้ายังไม่มี server-side protection ที่ยืนยันได้ ให้เริ่มเฉพาะขนาดที่ยอมรับการขาดทุนจาก gap
  หรือช่วงระบบล่มได้ โดยไม่พึ่งคำสัญญาว่าบอทจะปิดทัน

จนกว่าหลักฐานเหล่านี้ครบ สถานะคือ `REAL-NO-GO`.
