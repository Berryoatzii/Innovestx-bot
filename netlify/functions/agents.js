// Netlify Function: /api/agents
// 7-Layer Multi-Agent Investment Intelligence System
// Architecture: Regime → Value/Momentum/Growth/Risk/Quant → Master Allocation AI

const https = require('https');

const GEMINI_KEY  = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.0-flash';

// ── Utility ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Low-level Gemini HTTP — returns { statusCode, body } or { error }
function geminiHTTP(bodyStr) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'generativelanguage.googleapis.com',
      path: '/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + GEMINI_KEY,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
    };
    const req = https.request(opts, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: d }));
    });
    req.on('error', err => resolve({ error: err.message }));
    req.setTimeout(12000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.write(bodyStr); req.end();
  });
}

// Text completion with 429 retry
async function askGemini(prompt, maxTokens = 800, temperature = 0.4) {
  if (!GEMINI_KEY) return '⚠️ ไม่พบ GEMINI_API_KEY';
  const bodyStr = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature },
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await geminiHTTP(bodyStr);
    if (r.error === 'timeout' || r.error) {
      if (attempt < 3) { await sleep(2000 * attempt); continue; }
      return '⚠️ ' + (r.error === 'timeout' ? 'Timeout' : r.error);
    }
    if (r.statusCode === 429) {
      if (attempt < 3) { await sleep(2000 * attempt); continue; }
      return '⚠️ Gemini quota หมด ลองใหม่ภายหลัง';
    }
    try {
      const p = JSON.parse(r.body);
      if (p.error) return '⚠️ ' + p.error.message;
      return p.candidates?.[0]?.content?.parts?.[0]?.text || '⚠️ AI ไม่ตอบ';
    } catch { return '⚠️ Parse error'; }
  }
  return '⚠️ Max retries';
}

// JSON completion — returns parsed object or null
async function askGeminiJSON(prompt, maxTokens = 1200) {
  const text = await askGemini(prompt + '\n\nตอบ JSON เท่านั้น ไม่มีข้อความอื่น', maxTokens, 0.2);
  if (text.startsWith('⚠️')) return null;
  try {
    // Strip markdown code fences if present
    const clean = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch { return null; }
}

// ════════════════════════════════════════════════════════════════════════════
//  LAYER 1 — MARKET REGIME ENGINE
// ════════════════════════════════════════════════════════════════════════════
const REGIME_TYPES = {
  BULL_MOMENTUM:  { label: 'Bull Momentum',  weights: { value:0.15, momentum:0.30, growth:0.25, macro:0.15, quant:0.15 } },
  BULL_VALUE:     { label: 'Bull Value',     weights: { value:0.35, momentum:0.20, growth:0.15, macro:0.15, quant:0.15 } },
  SIDEWAYS:       { label: 'Sideways',       weights: { value:0.25, momentum:0.15, growth:0.20, macro:0.25, quant:0.15 } },
  BEAR_DEFENSIVE: { label: 'Bear Defensive', weights: { value:0.35, momentum:0.10, growth:0.10, macro:0.30, quant:0.15 } },
  LIQUIDITY_RISK: { label: 'Liquidity Risk', weights: { value:0.20, momentum:0.10, growth:0.05, macro:0.45, quant:0.20 } },
  RECOVERY:       { label: 'Recovery',       weights: { value:0.30, momentum:0.20, growth:0.20, macro:0.15, quant:0.15 } },
};

async function detectMarketRegime() {
  const prompt = `คุณคือ Ray Dalio + Stan Druckenmiller วิเคราะห์ Market Regime ตลาดหุ้นไทย SET

ประเมิน regime ปัจจุบัน (วันที่: ${new Date().toLocaleDateString('th-TH')}) และตอบ JSON:
{
  "type": "BULL_MOMENTUM|BULL_VALUE|SIDEWAYS|BEAR_DEFENSIVE|LIQUIDITY_RISK|RECOVERY",
  "confidence": 55,
  "macro_signals": {
    "fed_stance": "HAWKISH|NEUTRAL|DOVISH",
    "set_vs_ema200": "ABOVE|BELOW|AT",
    "liquidity": "TIGHT|NEUTRAL|AMPLE",
    "risk_mode": "RISK_ON|NEUTRAL|RISK_OFF"
  },
  "summary": "อธิบาย 2 ประโยคภาษาไทย",
  "top_strategies": ["strategy1", "strategy2"]
}`;
  const result = await askGeminiJSON(prompt, 600);
  if (!result) {
    return { type: 'SIDEWAYS', confidence: 50, summary: 'ไม่สามารถวิเคราะห์ตลาดได้', macro_signals: {}, top_strategies: [] };
  }
  return result;
}

// ════════════════════════════════════════════════════════════════════════════
//  LAYERS 2-6 COMBINED — Batch stock analysis
//  Analyzes up to 8 stocks in a single AI call
// ════════════════════════════════════════════════════════════════════════════
async function analyzeStockBatch(stocks, regime) {
  const regimeInfo = REGIME_TYPES[regime.type] || REGIME_TYPES.SIDEWAYS;

  const stockList = stocks.map(s => {
    const pnl = s.avg > 0 ? ((s.mkt - s.avg) / s.avg * 100).toFixed(1) : '0';
    return `${s.sym}: ราคาปัจจุบัน=${s.mkt} P/L=${pnl}% จำนวน=${s.qty}หุ้น`;
  }).join('\n');

  const prompt = `คุณคือ Zero-Sympathy 7-Layer Investment System วิเคราะห์หุ้น SET ไทย
Market Regime: ${regimeInfo.label} (confidence: ${regime.confidence}%)
Macro: ${JSON.stringify(regime.macro_signals || {})}

═══ ZERO-SYMPATHY PROTOCOL ═══
- ประเมินทุกหุ้นราวกับคุณถือเงินสดวันนี้ — "คุณจะซื้อหุ้นนี้ที่ราคาปัจจุบันไหม?"
- ราคาทุนเดิมไม่มีผลต่อการตัดสินใจ (Sunk Cost Eliminated)
- dca_eligible = false ถ้า P/L <= -30% (No Averaging Down — ห้ามซื้อเพิ่มในสิ่งที่กำลังพัง)
- reason_th ต้องเป็น forward-looking เท่านั้น

หุ้นที่ต้องวิเคราะห์:
${stockList}

สำหรับแต่ละหุ้น ให้ตอบ JSON array (ต้องมีครบทุกตัว):
[
  {
    "sym": "SYMBOL",
    "grade": "A|B|C|D",
    "layer2_value": 0-100,
    "layer3_momentum": 0-100,
    "layer4_growth": 0-100,
    "layer5_quant": 0-100,
    "layer6_risk": 0-100,
    "regime_fit": 0-100,
    "final_score": 0-100,
    "action": "STRONG_BUY|BUY|WATCHLIST|HOLD|SELL|STRONG_SELL",
    "target_pct": 0-12,
    "dca_eligible": true|false,
    "cut_eligible": true|false,
    "reason_th": "เหตุผล forward-looking 1 ประโยคภาษาไทย"
  }
]

คำนิยาม Grade (ประเมินจาก Forward Potential เท่านั้น):
A = Core Hold (fundamental แข็ง, trend ดี, final_score >= 65) — dca_eligible ได้เฉพาะ P/L > -30%
B = Trade (พอไปได้, final_score 45-64) — hold only
C = Dead Capital (fundamental แย่/trend พัง → EXIT, final_score < 45) — cut_eligible = true
D = Speculative (high risk, จำกัด 1-2%) — dca_eligible = false เสมอ

คำนิยาม Action:
STRONG_BUY: final >= 85
BUY: final 70-84
WATCHLIST: final 55-69
HOLD: final 45-54
SELL: final 30-44
STRONG_SELL: final < 30`;

  const result = await askGeminiJSON(prompt, 1600);
  if (!Array.isArray(result)) return null;
  return result;
}

// ════════════════════════════════════════════════════════════════════════════
//  LAYER 7 — MASTER ALLOCATION AI (pure math)
// ════════════════════════════════════════════════════════════════════════════
function masterAllocation(stockAnalysis, regime) {
  const weights = (REGIME_TYPES[regime.type] || REGIME_TYPES.SIDEWAYS).weights;

  return stockAnalysis.map(s => {
    // Re-compute final score with regime-adjusted weights
    const weighted =
      (s.layer2_value    || 50) * weights.value    +
      (s.layer3_momentum || 50) * weights.momentum +
      (s.layer4_growth   || 50) * weights.growth   +
      (s.regime_fit      || 50) * weights.macro     +
      (s.layer5_quant    || 50) * weights.quant;

    const adjustedScore = Math.round(weighted);

    let finalAction = s.action;
    if (adjustedScore >= 90) finalAction = 'STRONG_BUY';
    else if (adjustedScore >= 75) finalAction = 'BUY';
    else if (adjustedScore >= 60) finalAction = 'WATCHLIST';
    else if (adjustedScore >= 45) finalAction = 'HOLD';
    else if (adjustedScore >= 30) finalAction = 'SELL';
    else finalAction = 'STRONG_SELL';

    // Hard override: No Averaging Down — extract P/L from reason context not available here,
    // so enforce at grade level: Grade C/D stocks are never DCA eligible
    const dcaEligible = s.dca_eligible && s.grade === 'A' && adjustedScore >= 55;

    return { ...s, adjusted_score: adjustedScore, final_action: finalAction, dca_eligible: dcaEligible };
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  FULL PORTFOLIO ANALYSIS — orchestrates all 7 layers
// ════════════════════════════════════════════════════════════════════════════
async function runFullPortfolioAnalysis(portfolio) {
  // Layer 1: Market Regime
  const regime = await detectMarketRegime();
  await sleep(600);

  // Layers 2-6: Analyze in batches of 7
  const BATCH_SIZE = 7;
  const allAnalyzed = [];
  const errors = [];

  for (let i = 0; i < portfolio.length; i += BATCH_SIZE) {
    const batch = portfolio.slice(i, i + BATCH_SIZE);
    const batchResult = await analyzeStockBatch(batch, regime);
    if (batchResult) {
      allAnalyzed.push(...batchResult);
    } else {
      // Fallback: use rule-based scoring for failed stocks
      batch.forEach(s => {
        const pnl = s.avg > 0 ? ((s.mkt - s.avg) / s.avg * 100) : 0;
        const score = Math.max(10, Math.min(90, 50 + pnl * 0.5));
        const grade = pnl <= -70 ? 'C' : pnl <= -50 ? 'C' : pnl >= 20 ? 'A' : 'B';
        allAnalyzed.push({
          sym: s.sym, grade,
          layer2_value: 50, layer3_momentum: 50, layer4_growth: 50,
          layer5_quant: 50, layer6_risk: 50, regime_fit: 50,
          final_score: Math.round(score),
          action: score < 35 ? 'SELL' : score < 45 ? 'HOLD' : 'WATCHLIST',
          target_pct: grade === 'A' ? 8 : grade === 'B' ? 4 : 0,
          // No Averaging Down: only eligible if loss is within -30% AND grade is A
          dca_eligible: pnl > -30 && grade === 'A',
          cut_eligible: pnl <= -50 || grade === 'C',
          reason_th: `คำนวณจากกฎ P/L: ${pnl.toFixed(1)}%`,
        });
        errors.push(s.sym);
      });
    }
    if (i + BATCH_SIZE < portfolio.length) await sleep(800);
  }

  // Layer 7: Master Allocation
  const finalResults = masterAllocation(allAnalyzed, regime);

  // Build portfolio summary
  const gradeCount = { A: 0, B: 0, C: 0, D: 0 };
  const sellList = [], buyList = [], watchList = [];
  finalResults.forEach(s => {
    gradeCount[s.grade] = (gradeCount[s.grade] || 0) + 1;
    if (s.final_action === 'STRONG_SELL' || s.final_action === 'SELL') sellList.push(s.sym);
    else if (s.final_action === 'STRONG_BUY' || s.final_action === 'BUY') buyList.push(s.sym);
    else if (s.final_action === 'WATCHLIST') watchList.push(s.sym);
  });

  const avgScore = finalResults.length > 0
    ? Math.round(finalResults.reduce((sum, s) => sum + s.adjusted_score, 0) / finalResults.length)
    : 0;

  return {
    regime,
    stocks: finalResults,
    summary: {
      total: finalResults.length,
      grade_count: gradeCount,
      avg_portfolio_score: avgScore,
      sell_urgently: sellList,
      buy_dca: buyList,
      watchlist: watchList,
      errors_fallback: errors,
    },
    timestamp: new Date().toISOString(),
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  COUNCIL MEETING (for chat UI — keeps existing functionality)
// ════════════════════════════════════════════════════════════════════════════
const AGENTS = {
  buffett:   { name:'Warren Buffett', emoji:'🎩', color:'#ffc107', persona:`คุณคือ Warren Buffett ตอบสั้นๆ ชัดเจน ภาษาไทย ลงท้าย —Buffett` },
  minervini: { name:'Mark Minervini', emoji:'⚡', color:'#00e5ff', persona:`คุณคือ Mark Minervini เน้น SEPA Momentum ตอบภาษาไทย ลงท้าย —Minervini` },
  niwes:     { name:'ดร.นิเวศน์',     emoji:'📚', color:'#00e676', persona:`คุณคือ ดร.นิเวศน์ เน้น Thai VI ตอบภาษาไทย ลงท้าย —ดร.นิเวศน์` },
  dalio:     { name:'Ray Dalio',      emoji:'⚖️', color:'#ff6b6b', persona:`คุณคือ Ray Dalio เน้น Risk/Macro ตอบภาษาไทย ลงท้าย —Dalio` },
  lynch:     { name:'Peter Lynch',    emoji:'🚀', color:'#a78bfa', persona:`คุณคือ Peter Lynch เน้น Growth GARP ตอบภาษาไทย ลงท้าย —Lynch` },
};

async function runCouncilMeeting(topic, context = '', agentIds = null) {
  const selectedAgents = agentIds
    ? agentIds.map(id => ({ id, ...AGENTS[id] })).filter(a => a.name)
    : Object.entries(AGENTS).map(([id, a]) => ({ id, ...a }));

  const transcript = [];

  for (const agent of selectedAgents) {
    const text = await askGemini(
      `${agent.persona}\n\nหัวข้อ: ${topic}\n${context ? 'ข้อมูล:\n'+context+'\n' : ''}\nให้ความเห็น 2-3 ประโยค:`,
      280, 0.8
    );
    transcript.push({ agent: agent.id, name: agent.name, emoji: agent.emoji, color: agent.color, phase: 'initial', text });
    await sleep(400);
  }

  // Debate round
  const initialSummary = transcript.map(t => `${t.name}: ${t.text}`).join('\n');
  for (const agent of selectedAgents) {
    const otherViews = transcript.filter(t => t.phase === 'initial' && t.agent !== agent.id).map(t => `${t.name}: ${t.text}`).join('\n');
    const text = await askGemini(
      `${agent.persona}\n\nหัวข้อ: ${topic}\nความเห็นคนอื่น:\n${otherViews}\n\nตอบสนอง 1-2 ประโยค (เห็นด้วย/ไม่เห็นด้วย/เพิ่มเติม):`,
      200, 0.8
    );
    transcript.push({ agent: agent.id, name: agent.name, emoji: agent.emoji, color: agent.color, phase: 'debate', text });
    await sleep(400);
  }

  const allText = transcript.map(t => `[${t.phase}] ${t.emoji} ${t.name}: ${t.text}`).join('\n\n');
  const verdict = await askGemini(
    `ประธาน Investment Avengers Council สรุปการประชุมเรื่อง "${topic}"\n\nบันทึก:\n${allText}\n\nสรุป: 1.มติ 2.เหตุผล 3.ความเสี่ยง 4.คะแนนความมั่นใจ XX% ภาษาไทยกระชับ`,
    450, 0.3
  );

  return { topic, transcript, verdict, agentCount: selectedAgents.length, timestamp: new Date().toISOString() };
}

// ════════════════════════════════════════════════════════════════════════════
//  MAIN HANDLER
// ════════════════════════════════════════════════════════════════════════════
exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const action = event.queryStringParameters?.action || 'portfolio';
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}

  try {
    // ── 7-Layer full portfolio analysis ──
    if (action === 'portfolio') {
      if (!body.portfolio || body.portfolio.length === 0)
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'No portfolio data' }) };
      const result = await runFullPortfolioAnalysis(body.portfolio);
      return { statusCode: 200, headers: cors, body: JSON.stringify(result) };
    }

    // ── Regime detection only ──
    if (action === 'regime') {
      const regime = await detectMarketRegime();
      return { statusCode: 200, headers: cors, body: JSON.stringify(regime) };
    }

    // ── Council meeting (chat UI) ──
    if (action === 'council') {
      const portCtx = (body.portfolio || []).length > 0
        ? 'พอร์ต: ' + body.portfolio.map(p => `${p.sym}(${((p.mkt-p.avg)/p.avg*100).toFixed(0)}%)`).join(', ')
        : '';
      const result = await runCouncilMeeting(body.topic || 'ภาพรวมตลาด', portCtx + (body.context||''));
      return { statusCode: 200, headers: cors, body: JSON.stringify(result) };
    }

    // ── Market outlook meeting ──
    if (action === 'market') {
      const result = await runCouncilMeeting('ภาพรวมตลาดหุ้นไทย SET และโอกาสการลงทุน', '', ['dalio', 'niwes', 'lynch']);
      return { statusCode: 200, headers: cors, body: JSON.stringify(result) };
    }

    // ── Single stock debate ──
    if (action === 'debate') {
      if (!body.symbol) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'No symbol' }) };
      const result = await runCouncilMeeting(`วิเคราะห์หุ้น ${body.symbol}`, body.context || '', ['buffett', 'minervini', 'niwes']);
      return { statusCode: 200, headers: cors, body: JSON.stringify(result) };
    }

    // ── List agents ──
    if (action === 'agents') {
      return { statusCode: 200, headers: cors, body: JSON.stringify({
        agents: Object.entries(AGENTS).map(([id, a]) => ({ id, name: a.name, emoji: a.emoji, color: a.color })),
        regime_types: Object.keys(REGIME_TYPES),
      })};
    }

    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('[agents]', err);
    return { statusCode: 200, headers: cors, body: JSON.stringify({
      error: err.message, transcript: [], verdict: '⚠️ เกิดข้อผิดพลาด'
    })};
  }
};
