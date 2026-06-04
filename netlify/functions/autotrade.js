// Netlify Function: /api/autotrade 
// AI Fundamental Analysis + Google Search Grounding (ข้อมูล Real-time)

const https = require('https');

// --- 🔑 Environment Variables ---
const INVX_KEY = process.env.INVX_KEY || '';
const INVX_SEC = process.env.INVX_SECRET || '';
const INVX_PIN = process.env.INVX_PIN || '000000';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

exports.handler = async (event) => {
  if (!INVX_KEY || !GEMINI_KEY || !TG_TOKEN) {
    return { statusCode: 500, body: 'Missing API Keys' };
  }

  try {
    let actionLog = [];
    const portRaw = await fetchInnovestXPortfolio();
    const portfolio = normalizePortfolio(portRaw);
    
    if (portfolio.length === 0) {
      await sendTelegram('📊 <b>VI Bot:</b> พอร์ตปัจจุบันไม่มีหุ้น รอดักเก็บหุ้นพื้นฐานดีตอนตลาดตกนะครับ');
      return { statusCode: 200, body: 'Empty Portfolio' };
    }

    // วิเคราะห์หุ้นทีละตัว โดยดึงข่าวและงบการเงินแบบ Real-time จาก Google
    for (const stock of portfolio) {
      if (stock.avg <= 0) continue;

      const prompt = `วิเคราะห์หุ้นไทย ${stock.sym} (ตลาด SET)
คุณต้องค้นหาข้อมูลล่าสุดจากอินเทอร์เน็ต (ข่าววันนี้, งบไตรมาสล่าสุด) ก่อนวิเคราะห์เสมอ!
วิเคราะห์: 1. ความแข็งแกร่งธุรกิจ 2. งบการเงิน 3. ปันผล
ตอบเป็น JSON เท่านั้น:
{
  "action": "ACCUMULATE" หรือ "HOLD" หรือ "SELL",
  "fundamental_health": "STRONG" หรือ "STABLE" หรือ "WEAK",
  "dividend_outlook": "สรุปปันผล 1 ประโยค",
  "analysis": "สรุปจากข่าวและงบ 3 ประโยค",
  "warning": "ความเสี่ยงล่าสุด (ถ้าไม่มีใส่ -)"
}`;

      const aiResponse = await askGeminiJSON(prompt);
      if (!aiResponse || !aiResponse.action) continue;

      let reportMsg = `🏢 <b>อัปเดตพื้นฐาน & ข่าวล่าสุด: ${stock.sym}</b>\n`;
      reportMsg += `📦 ถือ: ${stock.qty} หุ้น | ทุน: ${stock.avg} | ตลาด: ${stock.mkt}\n\n`;
      
      const emojiHealth = aiResponse.fundamental_health === 'STRONG' ? '💪' : (aiResponse.fundamental_health === 'WEAK' ? '⚠️' : '⚖️');
      const emojiAction = aiResponse.action === 'ACCUMULATE' ? '🟢' : (aiResponse.action === 'SELL' ? '🔴' : '🟡');

      reportMsg += `${emojiHealth} <b>สุขภาพการเงิน:</b> ${aiResponse.fundamental_health}\n`;
      reportMsg += `💰 <b>ปันผล & ข่าว:</b> ${aiResponse.dividend_outlook}\n`;
      reportMsg += `🧠 <b>บทวิเคราะห์:</b> ${aiResponse.analysis}\n`;
      if (aiResponse.warning !== '-') reportMsg += `🚨 <b>ความเสี่ยงปัจจุบัน:</b> ${aiResponse.warning}\n`;
      reportMsg += `\n${emojiAction} <b>คำแนะนำจาก AI:</b> ${aiResponse.action}`;

      await sendTelegram(reportMsg);
      actionLog.push(`${stock.sym}: ${aiResponse.action}`);
      
      // หน่วงเวลา 3 วินาที ให้เวลา AI ค้นหา Google
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    return { statusCode: 200, body: 'VI Scan completed. ' + actionLog.join(', ') };

  } catch (err) {
    console.error('VI AutoTrade Error:', err);
    return { statusCode: 500, body: err.message };
  }
};

function fetchInnovestXPortfolio() {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'trade.innovestx.co.th', path: '/api/api-portal/v1/equity/portfolio', method: 'GET',
      headers: { 'api-key': INVX_KEY, 'api-secret': INVX_SEC }
    };
    https.get(opts, res => {
      let d = ''; res.on('data', c => d+=c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); }});
    }).on('error', reject);
  });
}

function normalizePortfolio(raw) {
  const items = Array.isArray(raw) ? raw : (raw?.positions || raw?.data || []);
  return items.map(p => ({
    sym:  p.symbol || p.ticker || p.Symbol || '',
    qty:  p.volume || p.quantity || p.Volume || 0,
    avg:  p.avgCost || p.avg_cost || p.AvgCost || 0,
    mkt:  p.lastPrice || p.last || p.Last || p.avgCost || 0,
  })).filter(p => p.sym && p.qty > 0);
}

function askGeminiJSON(prompt) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ "google_search": {} }], // เปิดพลังค้นหา Google แบบสดๆ
    generationConfig: { maxOutputTokens: 800, temperature: 0.2, responseMimeType: "application/json" }
  });
  return new Promise((resolve) => {
    const opts = {
      hostname: 'generativelanguage.googleapis.com',
      path: '/v1beta/models/gemini-2.0-flash:generateContent?key=' + GEMINI_KEY,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { 
          const p = JSON.parse(d); 
          const text = p.candidates?.[0]?.content?.parts?.[0]?.text;
          resolve(JSON.parse(text)); 
        } 
        catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

function sendTelegram(text) {
  const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: text, parse_mode: 'HTML' });
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.telegram.org', path: `/bot${TG_TOKEN}/sendMessage`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(opts, res => { res.on('data', ()=>{}); res.on('end', resolve); });
    req.on('error', resolve); req.write(body); req.end();
  });
}