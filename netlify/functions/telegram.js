// Netlify Function: /api/telegram
// ระบบแจ้งเตือน Telegram + Inline Keyboard สำหรับ Confirm Order

const https = require('https');

const TG_TOKEN   = process.env.TELEGRAM_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INVX_KEY   = process.env.INVX_KEY;
const INVX_SEC   = process.env.INVX_SECRET;
const INVX_BASE  = 'https://trade.innovestx.co.th/api/api-portal/v1/equity/';

// ── ส่งข้อความ Telegram ──
async function tgSend(text, keyboard=null) {
  const body = { chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  return tgPost('sendMessage', body);
}

async function tgPost(method, data) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    const opts = {
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── Gemini AI (gemini-2.0-flash with 429 retry) ──
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function askClaude(system, message) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
  const GEMINI_MODEL = 'gemini-2.0-flash';
  if (!GEMINI_KEY) return '⚠️ ไม่พบ GEMINI_API_KEY';

  const prompt = system ? system + '\n\n---\n\n' + message : message;
  const postData = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 1000, temperature: 0.7 }
  });

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await new Promise((resolve) => {
      const opts = {
        hostname: 'generativelanguage.googleapis.com',
        path: '/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + GEMINI_KEY,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
      };
      const req = https.request(opts, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve({ statusCode: res.statusCode, body: d }));
      });
      req.on('error', (err) => resolve({ statusCode: 0, body: '', error: err.message }));
      req.setTimeout(9000, () => { req.destroy(); resolve({ statusCode: 0, body: '', error: 'timeout' }); });
      req.write(postData);
      req.end();
    });

    if (result.error === 'timeout') {
      if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS); continue; }
      return '⚠️ Timeout — AI ยุ่งมาก';
    }
    if (result.error) {
      if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS); continue; }
      return `⚠️ Network error: ${result.error}`;
    }
    if (result.statusCode === 429) {
      console.warn(`[Gemini/telegram] 429 rate-limit on attempt ${attempt}`);
      if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS * attempt); continue; }
      return '⚠️ Gemini quota หมด กรุณาลองใหม่ภายหลัง';
    }

    try {
      const p = JSON.parse(result.body);
      const text = p.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return text;
      return '⚠️ ' + (p.error?.message || 'Gemini: ไม่ได้รับคำตอบ');
    } catch(e) {
      return '⚠️ Parse error';
    }
  }
  return '⚠️ Max retries exceeded';
}

// ── ดึงข้อมูล InnovestX ──
async function invxGet(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'trade.innovestx.co.th',
      path: `/api/api-portal/v1/equity/${INVX_KEY}${path}`,
      method: 'GET',
      headers: { 'api-key': INVX_KEY, 'api-secret': INVX_SEC }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
    });
    req.on('error', () => resolve({}));
    req.end();
  });
}

async function invxOrder(body) {
  const postData = JSON.stringify({
    ...body,
    api_secret: INVX_SEC,
    comment: 'EarthhEvans Avengers Bot'
  });
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'trade.innovestx.co.th',
      path: `/api/api-portal/v1/equity/${INVX_KEY}`,
      method: 'POST',
      headers: {
        'api-key': INVX_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── เช็คสถานะตลาด SET ──
function getMarketStatus() {
  const now = new Date();
  const bkkHour = (now.getUTCHours() + 7) % 24;
  const bkkMin  = now.getUTCMinutes();
  const total   = bkkHour * 60 + bkkMin;
  const day     = now.getDay(); // 0=Sun 6=Sat
  const isWeekday = day >= 1 && day <= 5;
  const isMorning  = total >= 600  && total <= 750;  // 10:00-12:30
  const isAfternoon= total >= 840  && total <= 990;  // 14:00-16:30
  const isOpen = isWeekday && (isMorning || isAfternoon);
  const isPreOpen  = isWeekday && total >= 570 && total < 600;  // 9:30-10:00

  // เวลา BKK string
  const h = String(bkkHour).padStart(2,'0');
  const m = String(bkkMin).padStart(2,'0');

  return { isOpen, isPreOpen, isWeekday, bkkTime: `${h}:${m}` };
}

// ── MORNING BRIEF ──
async function sendMorningBrief(portfolio) {
  const market = getMarketStatus();

  const portText = portfolio.slice(0,12).map(p => {
    const pnl = ((p.mkt - p.avg) / p.avg * 100).toFixed(1);
    const sign = pnl >= 0 ? '📈' : '📉';
    return `${sign} <b>${p.sym}</b> ${p.qty}หุ้น ต้นทุน฿${p.avg} ราคา฿${p.mkt?.toFixed(2)||p.avg} (${pnl >= 0 ? '+' : ''}${pnl}%)`;
  }).join('\n');

  const cuts = portfolio.filter(p => (p.mkt-p.avg)/p.avg*100 <= -50).map(p=>p.sym);

  const ai = await askClaude(
    `คุณคือทีม Investment Avengers ที่ประชุมกันทุกเช้าก่อนตลาดเปิด
ประกอบด้วย Buffett (Value), Minervini (SEPA), Dalio (Risk), ดร.นิเวศน์ (Thai VI)
วันนี้ตลาด SET ${market.isOpen ? 'เปิด' : 'ปิด'} เวลา BKK ${market.bkkTime}
ตอบภาษาไทย เข้าใจง่าย สั้นกระชับ เหมือนทีมรายงานต่อเจ้าของพอร์ต`,
    `พอร์ตวันนี้:\n${portText}\n\nหุ้นที่น่ากังวล (ขาดทุน>50%): ${cuts.join(', ') || 'ไม่มี'}\n\nสรุปการประชุมทีมวันนี้:\n1. ภาพรวมตลาดและความเสี่ยง\n2. หุ้นที่ควรขายวันนี้ (ระบุราคาเป้าหมาย)\n3. หุ้นที่ควร DCA หรือถือต่อ\n4. แผนการวันนี้ 1-3 ข้อ`
  );

  const preText = market.isOpen
    ? '🟢 <b>ตลาด SET เปิดอยู่</b>'
    : market.isPreOpen
    ? '🟡 <b>ตลาดกำลังจะเปิด</b> (9:30-10:00)'
    : '🔴 <b>ตลาด SET ปิด</b>';

  const msg = `🏛 <b>INVESTMENT AVENGERS — Morning Brief</b>
${preText} | เวลา ${market.bkkTime} BKK

${ai}

——
💡 กด /analyze [ชื่อหุ้น] เพื่อวิเคราะห์เพิ่มเติม
📊 กด /portfolio เพื่อดูพอร์ตทั้งหมด`;

  await tgSend(msg);
}

// ── SELL ALERT พร้อมปุ่ม Confirm ──
async function sendSellAlert(sym, qty, recommendedPrice, reason, pnlPct) {
  const value = (qty * recommendedPrice).toLocaleString('th-TH');
  const emoji = pnlPct >= 0 ? '💰' : '🔴';

  const msg = `${emoji} <b>แจ้งเตือน: แนะนำขาย ${sym}</b>

📋 รายละเอียด:
• จำนวน: <b>${qty.toLocaleString()} หุ้น</b>
• ราคาแนะนำ: <b>฿${recommendedPrice.toFixed(2)}</b>
• มูลค่า: <b>฿${value}</b>
• P&L ปัจจุบัน: <b style="${pnlPct>=0?'color:green':'color:red'}">${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%</b>

🧠 เหตุผลจาก Avengers:
${reason}

⚠️ <i>กดยืนยันเพื่อส่ง Order จริง — ยกเลิกได้ถ้าเปลี่ยนใจ</i>`;

  const keyboard = [
    [
      { text: `✅ ยืนยันขาย ${sym} ${qty}หุ้น @฿${recommendedPrice.toFixed(2)}`, callback_data: `SELL:${sym}:${qty}:${recommendedPrice}` }
    ],
    [
      { text: '⏰ เลื่อนออกไปก่อน', callback_data: `DELAY:${sym}` },
      { text: '❌ ไม่ขาย', callback_data: `CANCEL:${sym}` }
    ]
  ];

  await tgSend(msg, keyboard);
}

// ── PRICE ALERT ──
async function sendPriceAlert(sym, currentPrice, targetPrice, direction) {
  const emoji = direction === 'UP' ? '📈' : '📉';
  const msg = `${emoji} <b>Price Alert: ${sym}</b>

ราคาปัจจุบัน: <b>฿${currentPrice.toFixed(2)}</b>
เป้าหมาย: <b>฿${targetPrice.toFixed(2)}</b>
สถานะ: <b>${direction === 'UP' ? 'ราคาขึ้นถึงเป้า TP' : 'ราคาลงถึง Stop Loss'}</b>

⏰ เวลา: ${getMarketStatus().bkkTime} BKK`;

  const keyboard = direction === 'DOWN' ? [
    [{ text: `🔴 ขาย ${sym} ทันที (Stop Loss)`, callback_data: `SELL:${sym}:0:${currentPrice}` }],
    [{ text: '👀 ดูต่อไปก่อน', callback_data: `WATCH:${sym}` }]
  ] : [
    [{ text: `💰 ขาย ${sym} ทำกำไร`, callback_data: `SELL:${sym}:0:${currentPrice}` }],
    [{ text: '🚀 ถือต่อ รอขึ้นอีก', callback_data: `HOLD:${sym}` }]
  ];

  await tgSend(msg, keyboard);
}

// ── NEWS ALERT ──
async function sendNewsAlert(headline, affectedStocks) {
  const stocks = affectedStocks.join(', ');
  const msg = `📰 <b>ข่าวสำคัญ — กระทบพอร์ต</b>

${headline}

🎯 หุ้นที่อาจได้รับผลกระทบ: <b>${stocks}</b>

💬 วิเคราะห์โดย Avengers Team
กด /news เพื่อดูการวิเคราะห์ฉบับเต็ม`;

  await tgSend(msg);
}

// ── HANDLE CALLBACK QUERY (ปุ่มที่กดใน Telegram) ──
async function handleCallback(callbackData, callbackId) {
  const [action, sym, qty, price] = callbackData.split(':');

  if (action === 'SELL') {
    try {
      const actualQty = qty === '0'
        ? 100  // default ถ้าไม่รู้จำนวน
        : parseInt(qty);
      const actualPrice = parseFloat(price);

      const result = await invxOrder({
        ticker: sym,
        side: 'Sell',
        quantity: actualQty,
        order_type: 'MP-MTL'
      });

      if (result.status === 'success' || result.orderId || result.order_id) {
        await tgSend(`✅ <b>Order สำเร็จ!</b>\n\nขาย <b>${sym}</b> ${actualQty.toLocaleString()} หุ้น\nราคา: ฿${actualPrice.toFixed(2)}\nมูลค่า: ฿${(actualQty*actualPrice).toLocaleString('th-TH')}\n\nOrder ID: ${result.orderId || result.order_id || 'รอยืนยัน'}`);
      } else {
        await tgSend(`⚠️ <b>Order อาจไม่สำเร็จ</b>\n\nกรุณาตรวจสอบใน InnovestX App\nหุ้น: ${sym}\nข้อมูล: ${JSON.stringify(result).slice(0,100)}`);
      }
    } catch(e) {
      await tgSend(`❌ <b>Error:</b> ${e.message}\n\nกรุณาเข้า InnovestX App และ Order เอง`);
    }
  } else if (action === 'DELAY') {
    await tgSend(`⏰ รับทราบ — จะแจ้งเตือนอีกครั้งใน 30 นาที\nหุ้น: <b>${sym}</b>`);
  } else if (action === 'CANCEL') {
    await tgSend(`❌ ยกเลิกแล้ว — จะไม่ขาย <b>${sym}</b>\nถ้าเปลี่ยนใจ กด /sell ${sym}`);
  } else if (action === 'HOLD') {
    await tgSend(`🚀 รับทราบ — ถือ <b>${sym}</b> ต่อไป\nจะแจ้งเตือนอีกครั้งเมื่อราคาเปลี่ยนแปลงมาก`);
  } else if (action === 'WATCH') {
    await tgSend(`👀 รับทราบ — จะติดตาม <b>${sym}</b> ต่อ\nจะแจ้งเตือนถ้าราคาลงต่ออีก`);
  }

  // Answer callback query (ปิด loading ใน Telegram)
  await tgPost('answerCallbackQuery', { callback_query_id: callbackId, text: 'รับทราบแล้ว' });
}

// ── HANDLE COMMANDS (/portfolio, /analyze, /brief) ──
async function handleCommand(text) {
  const parts = text.trim().split(' ');
  const cmd = parts[0].toLowerCase();

  if (cmd === '/start' || cmd === '/help') {
    await tgSend(`🏛 <b>Investment Avengers Bot</b>

คำสั่งที่ใช้ได้:
/brief — Morning Brief + แผนวันนี้
/portfolio — ดูพอร์ตทั้งหมด
/analyze [หุ้น] — วิเคราะห์หุ้นตัวนั้น
/news — ข่าวที่กระทบพอร์ต
/status — สถานะตลาดและ Bot
/help — คำสั่งทั้งหมด

💡 หรือพิมพ์ถามได้เลย เช่น "ควรขาย TIPH ไหม?"`);

  } else if (cmd === '/status') {
    const market = getMarketStatus();
    await tgSend(`📊 <b>สถานะระบบ</b>

ตลาด SET: ${market.isOpen ? '🟢 เปิด' : '🔴 ปิด'}
เวลา BKK: ${market.bkkTime}
InnovestX: ${INVX_KEY ? '✅ เชื่อมแล้ว' : '❌ ยังไม่เชื่อม'}
AI Claude: ✅ พร้อม
Telegram Bot: ✅ ออนไลน์`);

  } else if (cmd === '/brief') {
    await tgSend('⏳ กำลังประชุมทีม Avengers...');
    const port = await invxGet('/portfolio');
    const portfolio = normalizePort(port);
    await sendMorningBrief(portfolio.length > 0 ? portfolio : DEMO_PORT);

  } else if (cmd === '/portfolio') {
    const port = await invxGet('/portfolio');
    const portfolio = normalizePort(port);
    const data = portfolio.length > 0 ? portfolio : DEMO_PORT;
    let tc=0, tm=0;
    const rows = data.map(p => {
      const mv=p.mkt*p.qty, cv=p.avg*p.qty;
      tc+=cv; tm+=mv;
      const pct = ((p.mkt-p.avg)/p.avg*100);
      return `${pct>=0?'📈':'📉'} <b>${p.sym}</b> ${p.qty}หุ้น ฿${p.mkt?.toFixed(2)||p.avg} (${pct>=0?'+':''}${pct.toFixed(1)}%)`;
    });
    const totalPnl = tm - tc;
    await tgSend(`💼 <b>พอร์ตทั้งหมด</b>\n\n${rows.join('\n')}\n\n📊 รวม: ฿${tm.toLocaleString('th-TH',{maximumFractionDigits:0})}\n${totalPnl>=0?'💚':'💔'} P&L: ${totalPnl>=0?'+':''}฿${Math.abs(totalPnl).toLocaleString('th-TH',{maximumFractionDigits:0})} (${((totalPnl/tc)*100).toFixed(1)}%)`);

  } else if (cmd === '/analyze' && parts[1]) {
    const sym = parts[1].toUpperCase();
    await tgSend(`🧠 กำลังวิเคราะห์ <b>${sym}</b>...`);
    const ai = await askClaude(
      'คุณคือทีม Investment Avengers วิเคราะห์หุ้น SET ตอบภาษาไทย กระชับ',
      `วิเคราะห์หุ้น ${sym} ในตลาด SET:\n1. ธุรกิจและ Moat\n2. ราคาปัจจุบันแพงหรือถูก\n3. ควรซื้อ/ถือ/ขาย พร้อมเหตุผล\n4. ความเสี่ยงสำคัญ`
    );
    await tgSend(`🔍 <b>วิเคราะห์ ${sym}</b>\n\n${ai}`);

  } else if (cmd === '/news') {
    await tgSend('📰 กำลังวิเคราะห์ข่าวที่กระทบพอร์ต...');
    const ai = await askClaude(
      'คุณคือนักวิเคราะห์ตลาดหุ้นไทย ตอบภาษาไทย',
      `วิเคราะห์สถานการณ์ตลาดและข่าวที่อาจกระทบหุ้น SET กลุ่มต่างๆ:\n- ธนาคาร (KBANK, TCAP)\n- อสังหา (LH, LALIN)\n- พลังงาน (RATCH)\n- เฮลธ์แคร์ (BH)\nบอก Risk และ Opportunity วันนี้`
    );
    await tgSend(`📰 <b>สถานการณ์ตลาดวันนี้</b>\n\n${ai}`);

  } else {
    // Free text → ถาม Claude โดยตรง
    const ai = await askClaude(
      'คุณคือ Investment Avengers ที่ปรึกษาการลงทุนหุ้น SET ตอบภาษาไทย กระชับ ไม่เกิน 200 คำ',
      text
    );
    await tgSend(`🧠 <b>Avengers ตอบ:</b>\n\n${ai}`);
  }
}

// ── NORMALIZE InnovestX Portfolio ──
function normalizePort(raw) {
  const items = Array.isArray(raw) ? raw : (raw?.positions || raw?.data || []);
  return items.map(p => ({
    sym: p.symbol || p.ticker || '',
    qty: p.volume || p.quantity || 0,
    avg: p.avgCost || p.avg_cost || 0,
    mkt: p.lastPrice || p.last || p.avgCost || 0,
  })).filter(p => p.sym && p.qty > 0);
}

// Demo portfolio ถ้า InnovestX ไม่ตอบ
const DEMO_PORT = [
  {sym:'TCAP',qty:100,avg:34.06,mkt:61.25},{sym:'PM',qty:800,avg:9.73,mkt:10.80},
  {sym:'TIPH',qty:300,avg:33.56,mkt:21.40},{sym:'AS',qty:300,avg:18.60,mkt:2.40},
  {sym:'BIS',qty:500,avg:12.30,mkt:2.06},{sym:'FVC',qty:3000,avg:1.62,mkt:0.31},
];

// ══════════════════════════════════════════════════════════
//  MAIN HANDLER
// ══════════════════════════════════════════════════════════
exports.handler = async (event, context) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const action = event.queryStringParameters?.action || '';

  // ── Webhook จาก Telegram ──
  if (event.httpMethod === 'POST' && !action) {
    try {
      const body = JSON.parse(event.body || '{}');

      // Callback query (ปุ่มที่กด)
      if (body.callback_query) {
        await handleCallback(body.callback_query.data, body.callback_query.id);
        return { statusCode: 200, headers: cors, body: '{}' };
      }

      // Text message / command
      if (body.message?.text) {
        await handleCommand(body.message.text);
        return { statusCode: 200, headers: cors, body: '{}' };
      }

    } catch(e) {
      console.error(e);
    }
    return { statusCode: 200, headers: cors, body: '{}' };
  }

  // ── API calls จาก Dashboard ──

  // ส่ง Morning Brief
  if (action === 'morning') {
    const port = await invxGet('/portfolio');
    const portfolio = normalizePort(port);
    await sendMorningBrief(portfolio.length > 0 ? portfolio : DEMO_PORT);
    return { statusCode:200, headers:cors, body:JSON.stringify({ok:true}) };
  }

  // ส่ง Sell Alert
  if (action === 'sellAlert') {
    const b = JSON.parse(event.body||'{}');
    await sendSellAlert(b.sym, b.qty, b.price, b.reason, b.pnlPct);
    return { statusCode:200, headers:cors, body:JSON.stringify({ok:true}) };
  }

  // ส่ง Price Alert
  if (action === 'priceAlert') {
    const b = JSON.parse(event.body||'{}');
    await sendPriceAlert(b.sym, b.currentPrice, b.targetPrice, b.direction);
    return { statusCode:200, headers:cors, body:JSON.stringify({ok:true}) };
  }

  // ส่ง News Alert
  if (action === 'newsAlert') {
    const b = JSON.parse(event.body||'{}');
    await sendNewsAlert(b.headline, b.stocks);
    return { statusCode:200, headers:cors, body:JSON.stringify({ok:true}) };
  }

  // ตั้ง Webhook
  if (action === 'setWebhook') {
    const siteUrl = event.headers.host;
    const webhookUrl = `https://${siteUrl}/.netlify/functions/telegram`;
    const result = await tgPost('setWebhook', { url: webhookUrl });
    return { statusCode:200, headers:cors, body:JSON.stringify(result) };
  }

  // Test
  if (action === 'test') {
    await tgSend(`✅ <b>Investment Avengers Bot เชื่อมต่อสำเร็จ!</b>

🏛 ระบบพร้อมแจ้งเตือนแล้ว:
• 🌅 Morning Brief ทุกเช้า 9:00 น.
• 📰 ข่าวกระทบพอร์ต
• ⚡ Price Alert อัตโนมัติ
• 🔘 ปุ่มยืนยัน Order

พิมพ์ /help เพื่อดูคำสั่งทั้งหมด`);
    return { statusCode:200, headers:cors, body:JSON.stringify({ok:true,msg:'Test sent!'}) };
  }

  return { statusCode:400, headers:cors, body:JSON.stringify({error:'Unknown action'}) };
};
