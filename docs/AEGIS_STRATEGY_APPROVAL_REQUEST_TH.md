# คำขออนุมัติ Strategy/Logic/Parameters — AEGIS RC2

> **DRAFT — ยังไม่ส่ง:** เอกสารนี้พร้อมให้ผู้ใช้ตรวจและอนุมัติผู้รับ/เนื้อหาแยกต่างหาก ระบบยังไม่เปิด Production Trading

เอกสารนี้ไม่มีเลขบัญชี, App ID, Secret, PIN หรือ Token และไม่ใช่คำสั่งซื้อขาย

## ขอบเขตที่ขอให้ InnovestX ยืนยัน

- Candidate ID: `AEGIS-DR-ROTATION-RC2-2026-08-31`
- Strategy version: `DIVERSIFIED_DR_TREND_BUFFER_V1.0.0`
- Candidate file: `config/strategy-approval-candidate.json`
- SHA-256: `609a4773b6a9f8bd93e103ba3cd36fa310402adcec4e82d27a187511d4262059`
- ตลาด/ช่องทาง: DR ที่ซื้อขายในตลาดไทยผ่าน Settrade Open API/SDK (`ALGO_EQ Production`)
- สัญลักษณ์: `SP50001`, `NDX01`, `INDIA01`, `CN01`, `BONDUS01`, `GOLDUS03`
- บัญชี: Cash Balance, long-only, fully paid, ไม่ใช้ leverage, ไม่ short, ไม่ใช้ TFEX
- รูปแบบ: ระบบคำนวณจากกฎตายตัว แต่ทุก Place/Change/Cancel ต้องมี human approval แยกรายการ
- Pilot: ไม่เกิน 1 ออเดอร์ต่อวัน, มูลค่าไม่เกิน 3,500 บาท และรักษาเงินสดหลังซื้ออย่างน้อย 5,000 บาท
- Order: Resting Limit เท่านั้น; ไม่ใช้ Market/ATO/ATC
- Exit: อนุญาตขายครบสถานะเฉพาะ DR ที่อยู่ใน candidate นี้เมื่อหลุด eligibility/rank และยังต้องอนุมัติรายออเดอร์
- ความไม่แน่นอน: ไม่ retry broker อัตโนมัติ; reconcile-only

## Strategy/Logic/Parameters

1. ประเมินข้อมูลปิดรายเดือนของ DR ทั้ง 6 ตัวผ่านตัวแทนดัชนี/ETF ที่ระบุใน candidate
2. ต้องมีข้อมูล warm-up 12 เดือน
3. ผ่าน eligibility เมื่อราคาปัจจุบันสูงกว่าค่าเฉลี่ยราคาปิด 12 เดือนก่อนหน้า และ momentum 6 เดือนเป็นบวก
4. เรียงลำดับ momentum จากมากไปน้อย เลือกได้สูงสุด 3 ตัว
5. น้ำหนักเป้าหมายตัวละไม่เกิน 5% และ gross exposure รวมไม่เกิน 15%
6. Rebalance รายไตรมาส; position เดิมถือได้ต่อหากยังอยู่ไม่เกินอันดับ 5 (no-trade buffer)
7. ขายครบสถานะ DR นั้นเมื่อหลุด eligibility หรืออยู่นอก retention rank
8. เงินสดเป้าหมายขั้นต่ำ 20% และห้ามใช้ Credit Limit เป็นฐาน sizing

## หลักฐานวิจัย

- Candidate ถูก freeze ก่อนเปิด final holdout และผูก hash กับ implementation/universe
- Final holdout: ส.ค. 2567–ก.ค. 2569 ผ่านครบต้นทุน turnover 0.268%, 0.5% และ 1.0%
- ผลตอบแทนหลังต้นทุน final holdout +4.34% ถึง +4.66%
- ชนะ benchmark ที่ใช้ gross exposure เท่ากัน +0.35% ถึง +0.51%
- Maximum drawdown ประมาณ -0.95%

ผลย้อนหลังไม่รับรองผลตอบแทนในอนาคต และแม้ได้รับอนุมัติ ระบบยังต้องผ่าน execution compatibility, forward shadow, production read-only, zero unresolved, Telegram human approval และ commit attestation ก่อนเปิดเงินจริง

## ร่างข้อความสำหรับส่งจากอีเมลส่วนตัวที่ลงทะเบียน

หัวข้อ: ขออนุมัติ Strategy/Logic/Parameters สำหรับ DR ผ่าน Settrade Open API — AEGIS RC2

เรียน ทีม InnovestX

บัญชีของข้าพเจ้าได้รับการ activate Settrade Open API แล้ว ข้าพเจ้าขอให้บริษัทตรวจสอบและยืนยันเป็นลายลักษณ์อักษรว่าสามารถใช้ Strategy/Logic/Parameters ต่อไปนี้ผ่าน ALGO_EQ Production ได้หรือไม่:

- Candidate ID: AEGIS-DR-ROTATION-RC2-2026-08-31
- Version: DIVERSIFIED_DR_TREND_BUFFER_V1.0.0
- SHA-256: 609a4773b6a9f8bd93e103ba3cd36fa310402adcec4e82d27a187511d4262059
- DR: SP50001, NDX01, INDIA01, CN01, BONDUS01, GOLDUS03
- Cash Balance, long-only, fully paid, no leverage/short/TFEX
- Human approval ต่อ Place/Change/Cancel ทุกออเดอร์ และใช้ Resting Limit เท่านั้น
- Pilot สูงสุด 1 ออเดอร์และ 3,500 บาทต่อวัน
- การขายครบสถานะจำกัดเฉพาะ DR ใน candidate เมื่อหลุด eligibility/rank และต้องอนุมัติรายออเดอร์
- ไม่มี automatic broker retry; หากผลไม่แน่นอนจะ reconcile อย่างเดียว

Logic และ Parameters ที่ขออนุมัติ:

- ใช้ข้อมูลปิดรายเดือน, warm-up 12 เดือน, trend filter คือราคาปัจจุบันสูงกว่าค่าเฉลี่ยราคาปิด 12 เดือนก่อนหน้า และ momentum 6 เดือนต้องเป็นบวก
- เรียง momentum จากมากไปน้อย เลือกสูงสุด 3 DR, น้ำหนักเป้าหมายไม่เกินตัวละ 5% และ gross exposure รวมไม่เกิน 15%
- Rebalance รายไตรมาส; position เดิมถือได้ต่อเมื่อยังอยู่ไม่เกินอันดับ 5
- ขายครบเฉพาะสถานะ DR ใน candidate เมื่อหลุด eligibility หรืออยู่นอก retention rank โดยยังต้องอนุมัติรายออเดอร์
- เงินสดเป้าหมายขั้นต่ำ 20%, pilot ไม่เกิน 1 ออเดอร์/วัน, มูลค่าและ notional ต่อวันไม่เกิน 3,500 บาท และเงินสดหลังรายการไม่น้อยกว่า 5,000 บาท

Final holdout ช่วง ส.ค. 2567–ก.ค. 2569 ผ่านครบทั้งสมมติฐานต้นทุน turnover 0.268%, 0.5% และ 1.0% แต่ผลย้อนหลังไม่รับรองผลตอบแทนในอนาคต

โปรดยืนยันเป็นลายลักษณ์อักษรให้ชัดว่าการอนุมัติครอบคลุม Place/Change/Cancel ผ่าน Settrade Open API/SDK สำหรับ candidate/version/hash และ Logic/Parameters ข้างต้นหรือไม่ หากยังไม่สามารถอนุมัติได้ โปรดระบุขั้นตอน แบบฟอร์ม หรือพารามิเตอร์ที่ต้องแก้ไข

ขอบคุณครับ

หมายเหตุ: ร่างนี้ยังไม่ถูกส่ง ผู้ใช้ต้องยืนยันผู้รับและเนื้อหาก่อนส่ง
