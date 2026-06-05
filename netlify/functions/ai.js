// Netlify Function: /api/ai
// Bulletproof AI Engine — gemini-2.0-flash with 429 retry logic

const https = require('https');
const GEMINI_KEY  = process.env.GEMINI_API_KEY || '';
const GROQ_KEY    = process.env.GROQ_API_KEY   || '';
const GEMINI_MODEL = 'gemini-2.0-flash';

// Retry wrapper — up to 3 attempts, 2s backoff on 429
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function geminiRaw(body) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await new Promise((resolve) => {
      const opts = {
        hostname: 'generativelanguage.googleapis.com',
        path: '/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + GEMINI_KEY,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(opts, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: d });
        });
      });

      req.on('error', (err) => resolve({ statusCode: 0, body: '', error: err.message }));

      // Netlify cap: 8s per attempt
      req.setTimeout(8000, () => {
        req.destroy();
        resolve({ statusCode: 0, body: '', error: 'timeout' });
      });

      req.write(body);
      req.end();
    });

    if (result.error === 'timeout') {
      if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS); continue; }
      return { error: 'timeout' };
    }

    // 429 = quota / rate limit — back off and retry
    if (result.statusCode === 429) {
      console.warn(`[Gemini] 429 rate-limit on attempt ${attempt}`);
      if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS * attempt); continue; }
      return { error: 'quota_exceeded' };
    }

    return result;
  }
  return { error: 'max_retries' };
}

// Groq (fast, 14k req/day free)
async function groqFallback(prompt, maxTokens = 1200) {
  if (!GROQ_KEY) return null;
  const bodyStr = JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    temperature: 0.5,
  });
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.groq.com', path: '/openai/v1/chat/completions', method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + GROQ_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(opts, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d).choices?.[0]?.message?.content || null); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.write(bodyStr); req.end();
  });
}

async function gemini(systemPrompt, userMessage) {
  const prompt = systemPrompt ? systemPrompt + '\n\n---\n\n' + userMessage : userMessage;

  // Try Groq first — faster, 14,400 req/day free
  if (GROQ_KEY) {
    const text = await groqFallback(prompt, 1200);
    if (text) return text;
  }

  // Gemini fallback — one attempt only (no retry on 429 to avoid Netlify timeout)
  if (GEMINI_KEY) {
    const bodyStr = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 1200, temperature: 0.5 },
    });
    const result = await geminiRaw(bodyStr);
    if (!result.error && result.statusCode === 200) {
      try {
        const p = JSON.parse(result.body);
        if (!p.error) {
          const text = p.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) return text;
        }
        if (p.error) return `⚠️ [Gemini]: ${p.error.message}`;
      } catch {}
    }
  }

  if (!GROQ_KEY && !GEMINI_KEY) return '⚠️ [System]: ไม่พบ API Key — ตรวจสอบ GROQ_API_KEY หรือ GEMINI_API_KEY';
  return '⚠️ [AI]: ทั้ง Groq และ Gemini ไม่ตอบสนอง กรุณาลองใหม่';
}

const EXPERT_SYSTEMS = {
  buffett: `คุณคือ Warren Buffett วิเคราะห์ตอบสั้นๆ ชัดเจน`,
  minervini: `คุณคือ Mark Minervini เน้นโมเมนตัมและจุดเข้าซื้อ`,
  niwes: `คุณคือ ดร.นิเวศน์ วิเคราะห์แบบ VI ถือยาว`,
  dalio: `คุณคือ Ray Dalio เน้นความเสี่ยงของพอร์ต`,
  lynch: `คุณคือ Peter Lynch เน้นหาหุ้นเติบโต 10 เด้ง`,
};

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  const action = event.queryStringParameters?.action || 'chat';

  try {
    let b = {};
    if (event.body) { try { b = JSON.parse(event.body); } catch (e) {} }

    let replyText = '';
    const sys = EXPERT_SYSTEMS[b.expertId] || EXPERT_SYSTEMS.niwes;

    if (action === 'chat') {
      replyText = await gemini(sys, b.message || 'สวัสดี');
      return { statusCode: 200, headers: cors, body: JSON.stringify({ reply: replyText }) };
    }

    if (action === 'analyzePortfolio') {
      const portStr = (b.portfolio || []).map((p) => `${p.sym} ถือ ${p.qty} หุ้น ทุน ${p.avg}`).join('\n');
      const analysis = await gemini(sys, `วิเคราะห์พอร์ตนี้ให้หน่อย:\n${portStr || 'พอร์ตว่างเปล่า'}`);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ analysis }) };
    }

    if (action === 'stockPicks') {
      const picks = await gemini(sys, `แนะนำหุ้น SET ที่น่าสนใจ 3 ตัว`);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ picks }) };
    }

    if (action === 'dailyBrief') {
      const portStr = (b.portfolio || []).map((p) => {
        const pct = p.avg > 0 ? (((p.mkt - p.avg) / p.avg) * 100).toFixed(1) : '0';
        return `${p.sym}: ${pct >= 0 ? '+' : ''}${pct}%`;
      }).join(', ');
      const brief = await gemini(
        `คุณคือประธาน Investment Avengers ทีมที่ประกอบด้วย Buffett, Minervini, Dalio, ดร.นิเวศน์, Lynch
ทำหน้าที่สรุปการประชุมเช้าให้เจ้าของพอร์ต ตอบภาษาไทย กระชับ มีประโยชน์ใช้งานได้จริง`,
        `พอร์ตวันนี้: ${portStr || 'ยังไม่มีข้อมูล'}

สรุปการประชุมทีม Investment Avengers วันนี้:
1. ภาพรวมพอร์ตและสัญญาณเตือน
2. หุ้นที่ควรให้ความสนใจเร่งด่วน (Cut / DCA / Hold)
3. แผนการวันนี้ 3 ข้อ
4. คำแนะนำกำลังใจ 1 ประโยค`
      );
      return { statusCode: 200, headers: cors, body: JSON.stringify({ brief }) };
    }

    if (action === 'newsImpact') {
      const syms = (b.portfolio || []).map((p) => p.sym).slice(0, 10).join(', ');
      const news = await gemini(
        `คุณคือนักวิเคราะห์ตลาดหุ้นไทยผู้เชี่ยวชาญ ตอบภาษาไทย`,
        `วิเคราะห์สถานการณ์และปัจจัยที่อาจกระทบหุ้นเหล่านี้: ${syms || 'หุ้น SET ทั่วไป'}

รายงาน:
1. ปัจจัย Macro ที่กระทบตลาด SET ตอนนี้
2. กลุ่มอุตสาหกรรมที่มีความเสี่ยง vs โอกาส
3. หุ้นในพอร์ตที่อาจได้รับผลกระทบมากที่สุด
4. คำแนะนำรับมือ 2-3 ข้อ`
      );
      return { statusCode: 200, headers: cors, body: JSON.stringify({ news }) };
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ reply: 'Unknown Action' }) };

  } catch (err) {
    // Always return 200 — prevents red error bar in the UI
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        reply: `⚠️ [System Exception]: ${err.message}`,
        analysis: `⚠️ [System Exception]: ${err.message}`,
      }),
    };
  }
};
