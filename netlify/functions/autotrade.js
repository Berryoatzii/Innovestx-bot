// Netlify Scheduled Function: autotrade
// 7-Layer AI-Graded Auto Trader
// Schedule: 08:30 BKK (01:30 UTC) + 14:30 BKK (07:30 UTC) Mon-Fri

const https = require('https');
const crypto = require('crypto');

// ── Settrade ECDSA-SHA256 Signer (sdk: settrade_v2/util.py) ───────────────────
const PKCS8_P256_PREFIX = Buffer.from(
  '3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex'
);
function signSettrade(appId, appSecret, params = '') {
  const ts = Date.now().toString();
  const content = `${appId}.${params}.${ts}`;
  const rawKey = Buffer.from(appSecret, 'base64');
  const pkcs8 = Buffer.concat([PKCS8_P256_PREFIX, rawKey]);
  const priv = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const sig = crypto.createSign('SHA256');
  sig.update(content, 'utf8');
  return { signature: sig.sign(priv, 'hex'), timestamp: ts };
}

// ── Environment ───────────────────────────────────────────────────────────────
const INVX_KEY     = process.env.INVX_KEY        || '';
const INVX_SECRET  = process.env.INVX_SECRET     || '';
const INVX_PIN     = process.env.INVX_PIN        || '';
const INVX_ACCOUNT = process.env.INVX_ACCOUNT    || '';
// Settrade Open API (sdk: settrade_v2/equity.py → InvestorEquity)
const SETTRADE_HOST = 'open-api.settrade.com';
const ACCT_PATH     = `/api/seos/v3/023/accounts/${INVX_ACCOUNT}`;
const GEMINI_KEY  = process.env.GEMINI_API_KEY  || '';
const GROQ_KEY    = process.env.GROQ_API_KEY    || '';
const TG_TOKEN    = process.env.TELEGRAM_TOKEN  || '';
const TG_CHAT_ID  = process.env.TELEGRAM_CHAT_ID || '';
const TRADE_MODE  = process.env.TRADE_MODE      || 'execute';

// ── Safety limits ─────────────────────────────────────────────────────────────
const MAX_SELLS_PER_RUN    = 3;      // Never liquidate more than 3 positions per run
const MIN_CASH_FOR_BUY     = 2000;   // Skip DCA if cash < 2000 baht
const HARD_CUT_SCORE       = 35;     // Sell if AI final_score < 35
const GRADE_C_AUTO_SELL    = true;   // Auto-sell Grade C stocks
const DEEP_LOSS_PCT        = -70;    // Also sell regardless of score if P/L ≤ -70%

// ── Utility ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Groq AI fallback (free tier: 14,400 req/day, OpenAI-compatible)
function groqRequest(prompt, maxTokens = 2000) {
  if (!GROQ_KEY) return Promise.resolve(null);
  const bodyStr = JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    temperature: 0.2,
    response_format: { type: 'json_object' },
  });
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + GROQ_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(opts, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(d);
          resolve(p.choices?.[0]?.message?.content || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.write(bodyStr);
    req.end();
  });
}

function httpsRequest(opts, postBody) {
  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: d }));
    });
    req.on('error', err => resolve({ error: err.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    if (postBody) req.write(postBody);
    req.end();
  });
}

// ── Settrade Open API: login ──────────────────────────────────────────────────
async function settradeLogin() {
  if (!INVX_KEY || !INVX_SECRET) throw new Error('INVX_KEY or INVX_SECRET not set');
  const { signature, timestamp } = signSettrade(INVX_KEY, INVX_SECRET);
  const loginBody = JSON.stringify({ apiKey: INVX_KEY, params: '', signature, timestamp });
  const opts = {
    hostname: SETTRADE_HOST,
    path: `/api/oam/v1/023/broker-apps/ALGO_EQ/login`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loginBody), 'Accept': 'application/json' },
  };
  const r = await httpsRequest(opts, loginBody);
  if (r.error) throw new Error('Settrade login error: ' + r.error);
  let parsed;
  try { parsed = JSON.parse(r.body); } catch { throw new Error('Settrade login parse error: ' + r.body.slice(0, 200)); }
  if (!parsed.access_token) throw new Error('Settrade login no token: ' + JSON.stringify(parsed).slice(0, 200));
  return { token: parsed.access_token, tokenType: parsed.token_type || 'Bearer' };
}

// ── Settrade Open API: fetch portfolio ───────────────────────────────────────
async function fetchPortfolio() {
  if (!INVX_ACCOUNT) throw new Error('INVX_ACCOUNT not set');
  const { token, tokenType } = await settradeLogin();
  const opts = {
    hostname: SETTRADE_HOST,
    path: `${ACCT_PATH}/portfolios`,
    method: 'GET',
    headers: { 'Authorization': `${tokenType} ${token}`, 'Accept': 'application/json' },
  };
  const r = await httpsRequest(opts);
  if (r.error) throw new Error('Portfolio fetch: ' + r.error);
  if (r.statusCode !== 200) throw new Error(`Portfolio API ${r.statusCode}: ${r.body.slice(0, 300)}`);
  try { return JSON.parse(r.body); }
  catch { throw new Error('Portfolio parse error: ' + r.body.slice(0, 200)); }
}

function normalizePortfolio(raw) {
  let items;
  if (Array.isArray(raw))                           items = raw;
  else if (Array.isArray(raw?.portfolioList))       items = raw.portfolioList;
  else if (Array.isArray(raw?.data?.portfolioList)) items = raw.data.portfolioList;
  else if (Array.isArray(raw?.data?.positions))     items = raw.data.positions;
  else if (Array.isArray(raw?.positions))           items = raw.positions;
  else if (Array.isArray(raw?.data))                items = raw.data;
  else                                              items = [];

  return items
    .filter(p => p.symbol && p.symbol !== 'TOTAL')
    .map(p => {
      const sym = p.symbol || '';
      const qty = Number(p.actualVolume || p.currentVolume || p.volume || p.quantity || 0);
      const avg = Number(p.averagePrice || p.avgCost || p.avg_cost || 0);
      const mkt = Number(p.marketPrice  || p.lastPrice  || p.last   || avg);
      const pnlPct = avg > 0 ? ((mkt - avg) / avg) * 100 : 0;
      return { sym, qty, avg, mkt, pnlPct, unrealizedPnl: (mkt - avg) * qty };
    })
    .filter(p => p.sym && p.qty > 0);
}

function extractCash(raw) {
  try {
    const d = raw?.data || raw;
    return Number(d?.cashBalance || d?.cash || d?.availableCash || 0);
  } catch { return 0; }
}

// ── Settrade Open API: place order ───────────────────────────────────────────
async function placeOrder(ticker, side, quantity, price = 0) {
  if (!INVX_ACCOUNT) return { success: false, error: 'INVX_ACCOUNT not set' };
  const { token, tokenType } = await settradeLogin();
  const settradeSide = (side || '').toLowerCase().startsWith('b') ? 'Buy' : 'Sell';
  const orderBody = {
    symbol:        ticker,
    side:          settradeSide,
    priceType:     price > 0 ? 'Limit' : 'ATO',
    validityType:  'Day',
    trusteeIdType: 'Local',
    volume:        quantity,
    qtyOpen:       0,
    clientType:    'Individual',
  };
  if (price > 0) orderBody.price = price;
  if (INVX_PIN) orderBody.pin = String(INVX_PIN);
  // Filter out null/undefined/empty (mirrors Python SDK: {k:v for k,v if v is not None})
  Object.keys(orderBody).forEach(k => {
    if (orderBody[k] === null || orderBody[k] === undefined || orderBody[k] === '') delete orderBody[k];
  });
  const bodyStr = JSON.stringify(orderBody);
  console.log('[AutoTrader] placeOrder:', JSON.stringify({ ...orderBody, pin: '***' }));
  const opts = {
    hostname: SETTRADE_HOST,
    path: `${ACCT_PATH}/orders`,
    method: 'POST',
    headers: {
      'Authorization': `${tokenType} ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Accept': 'application/json',
    },
  };
  const r = await httpsRequest(opts, bodyStr);
  console.log('[AutoTrader] order response HTTP', r.statusCode, ':', r.body?.slice(0, 300));
  if (r.error) return { success: false, error: r.error };
  try {
    const parsed = JSON.parse(r.body);
    if (r.statusCode === 200 || r.statusCode === 201) {
      return { success: true, orderId: parsed?.orderNo || parsed?.orderId || parsed?.order_id || parsed?.data?.orderId || 'OK' };
    }
    return { success: false, statusCode: r.statusCode, error: parsed?.message || r.body.slice(0, 300) };
  } catch { return { success: false, error: `HTTP ${r.statusCode}: ` + r.body.slice(0, 200) }; }
}

// ── 7-Layer AI Analysis (calls /api/agents internally via internal function) ──
async function runAIAnalysis(portfolio) {
  const bodyStr = JSON.stringify({ portfolio });
  const opts = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
  };

  // Build a combined regime + stock analysis prompt (1 single API call)
  // Note: avg cost included only for position-size context; AI must NOT use it as basis for hold/sell decisions
  const stockList = portfolio.map(s => {
    const pnl = s.avg > 0 ? ((s.mkt - s.avg) / s.avg * 100).toFixed(1) : '0';
    return `${s.sym}: ราคาปัจจุบัน=${s.mkt} P/L=${pnl}% จำนวน=${s.qty}หุ้น`;
  }).join('\n');

  const prompt = `คุณคือ Zero-Sympathy Institutional Fund Manager สำหรับตลาดหุ้นไทย SET
วันที่: ${new Date().toLocaleDateString('th-TH')}

═══ ZERO-SYMPATHY PROTOCOL (บังคับใช้เสมอ) ═══
1. ZERO-SYMPATHY: ประเมินทุกหุ้นราวกับคุณถือเงินสดอยู่วันนี้
   คำถามคือ "ถ้าไม่มีหุ้นนี้ คุณจะซื้อมันที่ราคาปัจจุบันนี้ไหม?"
   ถ้าคำตอบคือ "ไม่" → SELL ทันที ไม่ว่า P/L จะเป็นเท่าไร
2. SUNK COST ELIMINATION: ราคาทุนเดิมไม่มีผลต่อการตัดสินใจ
   ประเมินจาก forward potential เท่านั้น — อดีตที่ผ่านไปแล้วไม่สามารถเรียกคืนได้
3. NO AVERAGING DOWN: dca_eligible = false เสมอถ้า P/L <= -30%
   ห้ามแนะนำซื้อเพิ่มในสิ่งที่กำลังพัง

ขั้นตอน:
1. ประเมิน Market Regime ก่อน
2. วิเคราะห์แต่ละหุ้นตาม Forward Potential (ไม่ใช่ราคาทุนเดิม)

หุ้นในพอร์ต:
${stockList}

ตอบ JSON object เดียว:
{
  "regime": {
    "type": "BULL_MOMENTUM|BULL_VALUE|SIDEWAYS|BEAR_DEFENSIVE|RECOVERY",
    "summary": "สรุปตลาด 1 ประโยค"
  },
  "stocks": [
    {
      "sym": "SYMBOL",
      "grade": "A|B|C|D",
      "value_score": 0-100,
      "momentum_score": 0-100,
      "growth_score": 0-100,
      "risk_score": 0-100,
      "quant_score": 0-100,
      "final_score": 0-100,
      "action": "STRONG_BUY|BUY|WATCHLIST|HOLD|SELL|STRONG_SELL",
      "cut_eligible": true|false,
      "dca_eligible": true|false,
      "reason_th": "เหตุผล forward-looking 1 ประโยคภาษาไทย (ห้ามพูดถึงราคาทุนเดิม)"
    }
  ]
}

Grade (ประเมินจาก Forward Potential เท่านั้น):
A = fundamental แข็ง momentum ดี → ถือ (dca_eligible ได้ถ้า P/L > -30%)
B = ปานกลาง → ถือดู
C = fundamental แย่/trend พัง → EXIT ทันที (สินทรัพย์ตาย)
D = เก็งกำไร → จำกัด 1-2% ของพอร์ต

ตอบ JSON เท่านั้น`;

  // Try Groq first (fast, high free quota)
  if (GROQ_KEY) {
    try {
      const text = await groqRequest(prompt, 2000);
      if (text) {
        const clean = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(clean);
        if (parsed.regime && Array.isArray(parsed.stocks)) {
          console.log('[AutoTrader] Groq succeeded');
          return parsed;
        }
      }
    } catch (e) { console.warn('[AutoTrader] Groq error:', e.message); }
  }

  // Gemini fallback — single attempt
  if (GEMINI_KEY) {
    const analysisBodyStr = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 2000, temperature: 0.2 },
    });
    const analysisOpts = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(analysisBodyStr) },
    };
    try {
      const r = await httpsRequest(analysisOpts, analysisBodyStr);
      if (r.statusCode === 200) {
        const p = JSON.parse(r.body);
        const text = p.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const clean = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(clean);
        if (parsed.regime && Array.isArray(parsed.stocks)) return parsed;
      }
    } catch (e) { console.warn('[AutoTrader] Gemini error:', e.message); }
  }

  return null;
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  const bodyStr = JSON.stringify({ chat_id: TG_CHAT_ID, text: text.slice(0, 4096), parse_mode: 'HTML' });
  const opts = {
    hostname: 'api.telegram.org',
    path: `/bot${TG_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
  };
  const r = await httpsRequest(opts, bodyStr);
  if (r.error) console.warn('[TG]', r.error);
}

// ── CORE TRADER LOGIC ─────────────────────────────────────────────────────────
// portfolioOverride: pre-loaded from dashboard to avoid double InnovestX fetch
async function runAutoTrader(mode, portfolioOverride = null) {
  const result = {
    mode, orders_placed: [], orders_failed: [],
    analyzed: [], alerts: [], regime: null,
    summary: '', timestamp: new Date().toISOString(),
  };

  // 1. Get portfolio — use pre-loaded from dashboard OR fetch from InnovestX
  let portfolio = [];
  let cashBalance = 0;

  if (portfolioOverride && portfolioOverride.length > 0) {
    // Frontend sent its already-loaded portfolio — normalize field names
    portfolio = portfolioOverride.map(p => {
      const avg = Number(p.avg || p.avgCost || p.avg_cost || 0);
      const mkt = Number(p.mkt || p.lastPrice || p.last || avg);
      const qty = Number(p.qty || p.volume || p.quantity || 0);
      const pnlPct = avg > 0 ? ((mkt - avg) / avg) * 100 : 0;
      return { sym: p.sym || p.symbol || '', qty, avg, mkt, pnlPct, unrealizedPnl: (mkt - avg) * qty };
    }).filter(p => p.sym && p.qty > 0);
    console.log(`[AutoTrader] Using client portfolio: ${portfolio.length} stocks`);
  } else {
    // Fall back to server-side fetch
    try {
      const portfolioRaw = await fetchPortfolio();
      portfolio = normalizePortfolio(portfolioRaw);
      cashBalance = extractCash(portfolioRaw);
    } catch (err) {
      const msg = `Portfolio fetch failed: ${err.message}`;
      console.error(msg);
      if (mode !== 'dry_run') await sendTelegram(`<b>Auto Trader Error</b>\n${msg}`);
      result.summary = msg;
      return result;
    }
  }

  console.log(`[AutoTrader] mode=${mode} stocks=${portfolio.length} cash=${cashBalance}`);

  if (portfolio.length === 0) {
    result.summary = 'พอร์ตว่างเปล่า';
    if (mode !== 'dry_run') await sendTelegram('📊 <b>Auto Trader:</b> พอร์ตว่างเปล่า');
    return result;
  }

  // 2. Run 7-Layer AI analysis
  let aiResult = null;
  if (GROQ_KEY || GEMINI_KEY) {
    aiResult = await runAIAnalysis(portfolio.slice(0, 20)); // Limit to 20 stocks to stay within timeout
  }

  // 3. Map AI results back to portfolio stocks
  const stockMap = {};
  if (aiResult?.stocks) {
    aiResult.stocks.forEach(s => { stockMap[s.sym] = s; });
    result.regime = aiResult.regime;
  }

  // 4. Determine actions for each stock
  const sellCandidates = [];

  for (const stock of portfolio) {
    const ai = stockMap[stock.sym];
    const pnlPct = stock.pnlPct;

    // Build analysis record
    const record = {
      sym: stock.sym, qty: stock.qty, avg: stock.avg, mkt: stock.mkt,
      pnlPct: parseFloat(pnlPct.toFixed(2)),
      grade: ai?.grade || (pnlPct <= -70 ? 'C' : pnlPct <= -50 ? 'C' : pnlPct >= 20 ? 'A' : 'B'),
      final_score: ai?.final_score || Math.max(10, Math.min(90, 50 + pnlPct * 0.4)),
      action: ai?.action || (pnlPct <= -70 ? 'SELL' : pnlPct <= -50 ? 'SELL' : 'HOLD'),
      reason_th: ai?.reason_th || `P/L ${pnlPct.toFixed(1)}%`,
      cut_eligible: ai?.cut_eligible ?? (pnlPct <= DEEP_LOSS_PCT),
      // No Averaging Down: never DCA into a position down more than 30%
      dca_eligible: ai ? (ai.dca_eligible && pnlPct > -30) : false,
      value_score: ai?.value_score, momentum_score: ai?.momentum_score,
      growth_score: ai?.growth_score, risk_score: ai?.risk_score,
    };
    result.analyzed.push(record);

    // Determine if should sell
    const shouldSell = (
      (GRADE_C_AUTO_SELL && record.grade === 'C') ||
      record.final_score < HARD_CUT_SCORE ||
      pnlPct <= DEEP_LOSS_PCT ||
      record.action === 'STRONG_SELL' || record.action === 'SELL'
    );

    if (shouldSell) sellCandidates.push({ ...record, stock });
    else if (ai?.dca_eligible && cashBalance >= MIN_CASH_FOR_BUY && record.grade === 'A') {
      result.alerts.push({ sym: stock.sym, action: 'DCA_SIGNAL', reason: record.reason_th, pnlPct: parseFloat(pnlPct.toFixed(2)) });
    } else if (record.action === 'BUY' || record.action === 'STRONG_BUY') {
      result.alerts.push({ sym: stock.sym, action: 'TAKE_PROFIT_ZONE', reason: record.reason_th, pnlPct: parseFloat(pnlPct.toFixed(2)) });
    }
  }

  // 5. Sort sell candidates: worst score first, then worst P/L
  sellCandidates.sort((a, b) => a.final_score - b.final_score || a.pnlPct - b.pnlPct);
  const sellsToExecute = sellCandidates.slice(0, MAX_SELLS_PER_RUN);

  // 6. Execute or simulate sells
  for (const candidate of sellsToExecute) {
    const orderInfo = {
      sym: candidate.sym, side: 'Sell', qty: candidate.qty,
      grade: candidate.grade, final_score: candidate.final_score,
      pnlPct: candidate.pnlPct, mkt: candidate.mkt, reason: candidate.reason_th,
    };

    if (mode === 'execute') {
      console.log(`[AutoTrader] SELL ${candidate.sym} x${candidate.qty} grade=${candidate.grade} score=${candidate.final_score}`);
      try {
        const orderResult = await placeOrder(candidate.sym, 'Sell', candidate.qty);
        if (orderResult.success) result.orders_placed.push({ ...orderInfo, orderId: orderResult.orderId });
        else result.orders_failed.push({ ...orderInfo, error: orderResult.error });
      } catch (err) {
        result.orders_failed.push({ ...orderInfo, error: err.message });
      }
      await sleep(1200);
    } else {
      result.orders_placed.push({ ...orderInfo, orderId: 'SIMULATE', note: 'Mode: ' + mode });
    }
  }

  // 7. Build summary
  const gradeCount = { A:0, B:0, C:0, D:0 };
  result.analyzed.forEach(s => { gradeCount[s.grade] = (gradeCount[s.grade] || 0) + 1; });

  const plainSummary = [
    `🤖 Auto Trader [${mode.toUpperCase()}] — ${result.analyzed.length} หุ้น`,
    `📊 Regime: ${result.regime?.summary || 'ไม่ทราบ'}`,
    `Grade: A=${gradeCount.A} B=${gradeCount.B} C=${gradeCount.C} D=${gradeCount.D}`,
    result.orders_placed.filter(o => o.orderId !== 'SIMULATE').length > 0
      ? `✅ ขายแล้ว: ${result.orders_placed.filter(o=>o.orderId!=='SIMULATE').map(o=>`${o.sym}(${o.pnlPct}%)`).join(', ')}`
      : result.orders_placed.length > 0
      ? `📋 จะขาย: ${result.orders_placed.map(o=>`${o.sym}(${o.pnlPct}%)`).join(', ')}`
      : '✅ ไม่มีหุ้นถึงเกณฑ์ขาย',
    `💵 เงินสด: ${cashBalance.toLocaleString()} บาท`,
  ].join('\n');

  result.summary = plainSummary;

  // 8. Send Telegram
  if (mode !== 'dry_run') {
    const tgMsg = buildTelegramMsg(result, cashBalance, gradeCount);
    await sendTelegram(tgMsg);
  }

  return result;
}

function buildTelegramMsg(result, cashBalance, gradeCount) {
  const now = new Date().toLocaleString('th-TH', { timeZone:'Asia/Bangkok', dateStyle:'short', timeStyle:'short' });
  const modeIcon = result.mode === 'execute' ? '⚡' : '🔍';
  let msg = `<b>${modeIcon} Auto Trader [${result.mode.toUpperCase()}]</b>\n<i>${now} BKK</i>\n${'─'.repeat(24)}\n\n`;

  if (result.regime) msg += `🌍 <b>Regime:</b> ${result.regime.summary}\n\n`;

  msg += `<b>Grade พอร์ต:</b> 🟢A=${gradeCount.A} 🔵B=${gradeCount.B} 🔴C=${gradeCount.C} ⚫D=${gradeCount.D}\n\n`;

  const executed = result.orders_placed.filter(o => o.orderId !== 'SIMULATE');
  const simulated = result.orders_placed.filter(o => o.orderId === 'SIMULATE');

  if (executed.length > 0) {
    msg += `<b>✅ ขายแล้ว (${executed.length})</b>\n`;
    executed.forEach(o => {
      msg += `• <b>${o.sym}</b> ${o.qty}หุ้น @ MP-MTL | Grade=${o.grade} Score=${o.final_score}\n  ${o.reason}\n`;
    });
    msg += '\n';
  }
  if (simulated.length > 0) {
    msg += `<b>📋 จะขาย (${simulated.length})</b>\n`;
    simulated.forEach(o => { msg += `• <b>${o.sym}</b> ${o.qty}หุ้น | Grade=${o.grade} Score=${o.final_score} (${o.pnlPct}%)\n`; });
    msg += '\n';
  }
  if (result.orders_failed.length > 0) {
    msg += `<b>❌ ขายไม่สำเร็จ</b>\n`;
    result.orders_failed.forEach(o => { msg += `• ${o.sym}: ${o.error}\n`; });
    msg += '\n';
  }
  if (result.alerts.length > 0) {
    const dcas = result.alerts.filter(a => a.action === 'DCA_SIGNAL');
    if (dcas.length > 0) msg += `<b>🔵 DCA Signal:</b> ${dcas.map(a=>a.sym).join(', ')}\n`;
  }

  const noAction = result.analyzed.filter(s => s.action === 'HOLD' || s.action === 'WATCHLIST');
  if (noAction.length > 0) msg += `<b>⚪ Hold/Watch:</b> ${noAction.map(s=>s.sym).join(', ')}\n\n`;

  msg += `<i>💵 เงินสด: ${cashBalance.toLocaleString()} บาท | Max ${MAX_SELLS_PER_RUN} sells/run</i>`;
  return msg;
}

exports.handler = async (event) => {
  console.log('[AutoTrader] Scheduled run | mode:', TRADE_MODE);
  if (!INVX_KEY || !INVX_SECRET) return { statusCode: 500, body: 'Missing INVX credentials' };
  try {
    const result = await runAutoTrader(TRADE_MODE);
    return { statusCode: 200, body: JSON.stringify({ ok: true, mode: result.mode, sold: result.orders_placed.length }) };
  } catch (err) {
    console.error('[AutoTrader] Fatal:', err);
    if (TRADE_MODE !== 'dry_run') await sendTelegram(`<b>Auto Trader Fatal Error</b>\n${err.message}`).catch(()=>{});
    return { statusCode: 500, body: err.message };
  }
};

module.exports.runAutoTrader = runAutoTrader;
