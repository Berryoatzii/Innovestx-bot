// Netlify Function: /api/agents
// Multi-Agent AI Council — agents think, debate, and decide autonomously

const https = require('https');

const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-1.5-flash';

const AGENTS = {
  buffett: {
    name: 'Warren Buffett',
    emoji: '🎩',
    color: '#ffc107',
    role: 'Value Investor',
    persona: `คุณคือ Warren Buffett นักลงทุนระดับโลก
- เน้นหาธุรกิจที่ดีในราคาที่ยุติธรรม
- ชอบ moat กว้าง กระแสเงินสดแข็งแกร่ง
- เกลียดการเก็งกำไร ชอบถือยาว 5-10 ปี
- ตอบสั้น ตรงประเด็น มั่นใจ ใช้ภาษาไทย
- ลงท้ายด้วย "—Buffett"`,
  },
  minervini: {
    name: 'Mark Minervini',
    emoji: '⚡',
    color: '#00e5ff',
    role: 'SEPA Momentum',
    persona: `คุณคือ Mark Minervini แชมป์ US Investing Championship
- เน้น SEPA: Specific Entry Point Analysis
- หาหุ้นที่มี Super Performance — มูลค่าสูงขึ้นเร็ว
- ใช้ Technical: EMA50, EMA150, EMA200, Volume surge
- Cut loss เร็ว กำไรปล่อยวิ่ง
- ตอบสั้น ตรงประเด็น ใช้ภาษาไทย
- ลงท้ายด้วย "—Minervini"`,
  },
  niwes: {
    name: 'ดร.นิเวศน์',
    emoji: '📚',
    color: '#00e676',
    role: 'Thai VI Master',
    persona: `คุณคือ ดร.นิเวศน์ เหมวชิรวรากร VI ระดับตำนานของไทย
- เน้น Value Investment แบบไทย
- ดูงบการเงิน P/E P/BV ROE เงินปันผล
- ชอบธุรกิจที่เข้าใจง่าย บริหารโปร่งใส
- ถือยาว ทนต่อความผันผวน
- ตอบภาษาไทยกระชับ เข้าใจง่าย
- ลงท้ายด้วย "—ดร.นิเวศน์"`,
  },
  dalio: {
    name: 'Ray Dalio',
    emoji: '⚖️',
    color: '#ff6b6b',
    role: 'Risk Manager',
    persona: `คุณคือ Ray Dalio ผู้ก่อตั้ง Bridgewater Associates
- เน้น All Weather Portfolio และ Risk Parity
- มองภาพใหญ่: วงจรเศรษฐกิจ หนี้ ดอกเบี้ย เงินเฟ้อ
- กระจายความเสี่ยงอย่างชาญฉลาด
- คิดแบบ "Radical Transparency"
- ตอบสั้น ตรงประเด็น ใช้ภาษาไทย
- ลงท้ายด้วย "—Dalio"`,
  },
  lynch: {
    name: 'Peter Lynch',
    emoji: '🚀',
    color: '#a78bfa',
    role: 'Growth Hunter',
    persona: `คุณคือ Peter Lynch อดีตผู้จัดการ Magellan Fund
- เน้นหา "10-bagger" หุ้นที่ราคาวิ่งขึ้น 10 เท่า
- "Invest in what you know" ลงทุนในสิ่งที่รู้จัก
- ชอบ GARP: Growth at Reasonable Price
- ดู PEG ratio, earnings growth rate
- ตอบสั้น ตรงประเด็น ใช้ภาษาไทย
- ลงท้ายด้วย "—Lynch"`,
  },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Low-level HTTP call — returns { statusCode, body } or { error }
function geminiHTTP(bodyStr) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'generativelanguage.googleapis.com',
      path: '/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + GEMINI_KEY,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };

    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: d }));
    });

    req.on('error', (err) => resolve({ error: err.message }));
    req.setTimeout(9000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.write(bodyStr);
    req.end();
  });
}

// Retry wrapper — 3 attempts, 2s backoff on 429
async function askGemini(prompt, maxTokens = 600, temperature = 0.7) {
  if (!GEMINI_KEY) return '⚠️ ไม่พบ GEMINI_API_KEY';

  const bodyStr = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature },
  });

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await geminiHTTP(bodyStr);

    if (result.error === 'timeout') {
      if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS); continue; }
      return '⚠️ Timeout — AI ยุ่งมาก';
    }

    if (result.error) {
      if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS); continue; }
      return `⚠️ Network error: ${result.error}`;
    }

    if (result.statusCode === 429) {
      console.warn(`[Gemini/agents] 429 rate-limit on attempt ${attempt}`);
      if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS * attempt); continue; }
      return '⚠️ Gemini quota หมด กรุณาลองใหม่ภายหลัง';
    }

    try {
      const p = JSON.parse(result.body);
      if (p.error) return `⚠️ ${p.error.message}`;
      const text = p.candidates?.[0]?.content?.parts?.[0]?.text;
      return text || '⚠️ AI ไม่ตอบ';
    } catch (e) {
      return '⚠️ Parse error';
    }
  }

  return '⚠️ Max retries exceeded';
}

// Run a full council meeting on a topic
async function runCouncilMeeting(topic, context = '', agentIds = null) {
  const selectedAgents = agentIds
    ? agentIds.map((id) => ({ id, ...AGENTS[id] })).filter((a) => a.name)
    : Object.entries(AGENTS).map(([id, a]) => ({ id, ...a }));

  const transcript = [];

  // Phase 1: Each agent gives initial opinion
  for (const agent of selectedAgents) {
    const prompt = `${agent.persona}

หัวข้อการประชุม: ${topic}
${context ? `\nข้อมูลเพิ่มเติม:\n${context}` : ''}

ให้ความเห็นเริ่มต้นของคุณ (ไม่เกิน 3 ประโยค) เน้นมุมมองเฉพาะของคุณ:`;

    const opinion = await askGemini(prompt, 300, 0.8);
    transcript.push({ agent: agent.id, name: agent.name, emoji: agent.emoji, color: agent.color, phase: 'initial', text: opinion });
    await sleep(500);
  }

  // Phase 2: Each agent responds to the others (debate round)
  for (const agent of selectedAgents) {
    const otherOpinions = transcript
      .filter((t) => t.phase === 'initial' && t.agent !== agent.id)
      .map((t) => `${t.name}: ${t.text}`)
      .join('\n');

    const prompt = `${agent.persona}

หัวข้อ: ${topic}

ความเห็นของสมาชิกคนอื่น:
${otherOpinions}

ตอบสนองต่อความเห็นข้างต้น — คุณเห็นด้วยหรือไม่? มีจุดที่ไม่เห็นด้วยไหม? (ไม่เกิน 2 ประโยค)`;

    const response = await askGemini(prompt, 250, 0.8);
    transcript.push({ agent: agent.id, name: agent.name, emoji: agent.emoji, color: agent.color, phase: 'debate', text: response });
    await sleep(500);
  }

  // Phase 3: Moderator synthesizes final verdict
  const allOpinions = transcript
    .map((t) => `[${t.phase === 'initial' ? 'เริ่มต้น' : 'โต้แย้ง'}] ${t.emoji} ${t.name}: ${t.text}`)
    .join('\n\n');

  const verdictPrompt = `คุณคือประธานที่ประชุม Investment Avengers Council
สรุปการประชุมเรื่อง: "${topic}"

บันทึกการประชุม:
${allOpinions}

สรุปผลการประชุม:
1. มติของที่ประชุม (BUY/SELL/HOLD/WAIT หรือคำตอบตรงๆ)
2. เหตุผลหลัก (2-3 ประโยค)
3. เงื่อนไขสำคัญหรือความเสี่ยงที่ต้องระวัง
4. คะแนนความมั่นใจ: XX%

ตอบภาษาไทย กระชับ ชัดเจน`;

  const verdict = await askGemini(verdictPrompt, 500, 0.4);

  return {
    topic,
    transcript,
    verdict,
    agentCount: selectedAgents.length,
    timestamp: new Date().toISOString(),
  };
}

// Autonomous portfolio review — agents work by themselves
async function autonomousPortfolioReview(portfolio) {
  const portSummary = portfolio
    .map((p) => {
      const pnl = p.avg > 0 ? (((p.mkt - p.avg) / p.avg) * 100).toFixed(1) : '0.0';
      return `${p.sym}: ถือ ${p.qty} หุ้น ต้นทุน ${p.avg} ราคาตลาด ${p.mkt} (${pnl >= 0 ? '+' : ''}${pnl}%)`;
    })
    .join('\n');

  const topic = `วิเคราะห์และให้คำแนะนำพอร์ตการลงทุนนี้ทั้งหมด`;
  const context = `พอร์ตปัจจุบัน:\n${portSummary}`;

  return runCouncilMeeting(topic, context);
}

// Quick single-stock debate
async function debateStock(symbol, currentData = '') {
  const topic = `วิเคราะห์หุ้น ${symbol} — ควรซื้อ ถือ หรือขาย?`;
  return runCouncilMeeting(topic, currentData, ['buffett', 'minervini', 'niwes']);
}

// Market outlook meeting
async function marketOutlookMeeting() {
  const topic = 'ภาพรวมตลาดหุ้นไทย SET และโอกาสการลงทุนในสัปดาห์นี้';
  return runCouncilMeeting(topic, '', ['dalio', 'niwes', 'lynch']);
}

// ── MAIN HANDLER ──
exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const action = event.queryStringParameters?.action || 'council';
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}

  try {
    if (action === 'council') {
      const result = await runCouncilMeeting(
        body.topic || 'ภาพรวมตลาดวันนี้',
        body.context || '',
        body.agents || null
      );
      return { statusCode: 200, headers: cors, body: JSON.stringify(result) };
    }

    if (action === 'portfolio') {
      if (!body.portfolio || body.portfolio.length === 0) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'No portfolio data' }) };
      }
      const result = await autonomousPortfolioReview(body.portfolio);
      return { statusCode: 200, headers: cors, body: JSON.stringify(result) };
    }

    if (action === 'debate') {
      if (!body.symbol) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'No symbol' }) };
      }
      const result = await debateStock(body.symbol, body.context || '');
      return { statusCode: 200, headers: cors, body: JSON.stringify(result) };
    }

    if (action === 'market') {
      const result = await marketOutlookMeeting();
      return { statusCode: 200, headers: cors, body: JSON.stringify(result) };
    }

    if (action === 'agents') {
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({
          agents: Object.entries(AGENTS).map(([id, a]) => ({
            id,
            name: a.name,
            emoji: a.emoji,
            color: a.color,
            role: a.role,
          })),
        }),
      };
    }

    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (err) {
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({ error: err.message, transcript: [], verdict: '⚠️ เกิดข้อผิดพลาด' }),
    };
  }
};
