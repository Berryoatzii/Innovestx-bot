# คำขออนุมัติ Strategy/Logic/Parameters — AEGIS RC1

เอกสารนี้ไม่มีเลขบัญชี, App ID, Secret, PIN หรือ Token และไม่ใช่คำสั่งซื้อขาย

## ขอบเขตที่ขอให้ InnovestX ยืนยัน

- Candidate ID: `AEGIS-MOMENTUM-BREAKOUT-RC1-2026-08-31`
- Strategy version: `MOMENTUM_BREAKOUT_V1.0.0`
- Candidate file: `config/strategy-approval-candidate.json`
- SHA-256: `9ec7197a1899cdfa4ea9d6fdc847a0a9a926d06c039f40af0ee90d281cc2dae1`
- ตลาด: หุ้นไทย ผ่าน Settrade Open API/SDK (`ALGO_EQ Production`)
- บัญชี: Cash Balance, long-only, ไม่ใช้ leverage, ไม่ short, ไม่ใช้ TFEX
- รูปแบบ: ระบบสร้างข้อเสนอจากกฎตายตัว แต่ทุกออเดอร์ต้องได้รับ human approval แยกรายการ
- Pilot: ไม่เกิน 1 ออเดอร์ต่อวัน, มูลค่าไม่เกิน 3,500 บาท, ไม่เกิน 3,500 บาทต่อวัน
- Order: Resting Limit เท่านั้น; ไม่ใช้ Market/ATO/ATC; ไม่ขายหมดสถานะ
- ความไม่แน่นอน: ไม่ retry broker อัตโนมัติ; reconcile-only

## Logic สัญญาณซื้อ ACTIVE

ข้อมูลรายวันอย่างน้อย 220 แท่งและต้องไม่เก่าเกิน 7 วัน โดยจะเป็น `BUY_CANDIDATE` เฉพาะเมื่อครบทุกข้อ:

1. ดัชนี benchmark ปิดเหนือ EMA200
2. ราคาปิดสูงกว่า EMA20 และ EMA20 สูงกว่า EMA50
3. ราคาปิดทะลุจุดสูงสุด 20 วันก่อนหน้า
4. Volume เทียบค่าเฉลี่ย 20 วันไม่น้อยกว่า 1.2 เท่า
5. RSI(14) อยู่ระหว่าง 55–75
6. ราคาอยู่เหนือ EMA20 ไม่เกิน 2.5 ATR

สัญญาณออกเป็นเพียง `EXIT_REVIEW` เมื่อราคาปิดต่ำกว่า EMA20 หรือ trailing level เท่ากับ highest close 20 วันลบ 2 ATR ระบบไม่ขายอัตโนมัติ

## Risk และ Portfolio Parameters

- ACTIVE target 20%, เงินสดเป้าหมายขั้นต่ำ 20%
- ACTIVE ต่อหลักทรัพย์ไม่เกิน 5%, พร้อมกันไม่เกิน 4 ตัว
- Risk budget ต่อรายการ 0.5% ของทุนที่ใช้คำนวณ
- Reward-to-risk หลังค่าธรรมเนียมและ slippage ไม่น้อยกว่า 2.0
- เงินสดหลังซื้ออย่างน้อย 5,000 บาท
- Spread สูงสุด 3%; Limit ห่างราคาล่าสุดไม่เกิน 15%
- ต้องตรวจพอร์ต เงินสด ราคา bid/ask ออเดอร์ซ้ำ สถานะตลาด และ unresolved journal ก่อนส่ง

## Release Conditions

แม้ได้รับอนุมัติจากบริษัทสมาชิกแล้ว ระบบยังไม่เปิดทันที ต้องมี shadow evidence อย่างน้อย 20 วันทำการ, 100 decisions และ 10 simulated trades; ผลตอบแทนหลังต้นทุนและ excess return ต้องเป็นบวก; drawdown ต้องไม่ต่ำกว่า -10% พร้อม Production Read-Only, zero unresolved, Telegram approval และ commit attestation ที่ตรงกัน

`strategyReleaseApproved` และ `liveTradingEnabled` จะคงเป็น `false` จนกว่าจะได้รับคำตอบที่อ้างถึง Candidate ID/Version/Hash นี้อย่างชัดเจนและผ่าน release conditions ครบ

## ร่างข้อความสำหรับส่งจากอีเมลส่วนตัวที่ลงทะเบียน

หัวข้อ: ขออนุมัติ Strategy/Logic/Parameters สำหรับ Settrade Open API — AEGIS RC1

เรียน ทีม InnovestX

บัญชีของข้าพเจ้าได้รับการ activate Settrade Open API แล้วเมื่อวันที่ 5 มิถุนายน 2569 ข้าพเจ้าขอให้บริษัทตรวจสอบและยืนยันเป็นลายลักษณ์อักษรว่าสามารถใช้ Strategy/Logic/Parameters ต่อไปนี้ผ่าน ALGO_EQ Production ได้หรือไม่:

- Candidate ID: AEGIS-MOMENTUM-BREAKOUT-RC1-2026-08-31
- Version: MOMENTUM_BREAKOUT_V1.0.0
- SHA-256: 9ec7197a1899cdfa4ea9d6fdc847a0a9a926d06c039f40af0ee90d281cc2dae1
- Cash Balance, long-only, no leverage/short/TFEX
- Human approval ต่อออเดอร์, Resting Limit เท่านั้น
- Pilot สูงสุด 1 ออเดอร์และ 3,500 บาทต่อวัน
- ไม่มี automatic broker retry; หากผลไม่แน่นอนจะ reconcile อย่างเดียว

รายละเอียด Logic และ Risk Parameters อยู่ในเอกสารแนบ หากยังไม่สามารถอนุมัติได้ โปรดระบุขั้นตอน แบบฟอร์ม หรือพารามิเตอร์ที่ต้องแก้ไข และโปรดยืนยันให้ชัดว่าการอนุมัติครอบคลุม Place/Change/Cancel ผ่าน Settrade Open API/SDK หรือไม่

ขอบคุณครับ

หมายเหตุ: ร่างนี้ยังไม่ถูกส่ง ผู้ใช้ต้องตรวจผู้รับและเนื้อหาแล้วอนุมัติการส่งแยกต่างหาก
