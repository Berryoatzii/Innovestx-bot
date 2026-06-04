// Netlify Scheduled Function: autotrade
// Runs at 1:30 UTC (8:30 BKK) and 7:30 UTC (14:30 BKK) on weekdays
// Rule-based Auto Trader — no AI required for decisions, AI only for summary report

const https = require('https');

// ── Environment Variables ──────────────────────────────────────────────────────
const INVX_KEY    = process.env.INVX_KEY       || '';
const INVX_SECRET = process.env.INVX_SECRET    || '';
const INVX_PIN    = process.env.INVX_PIN        || '';
const GEMINI_KEY  = process.env.GEMINI_API_KEY  || '';
const TG_TOKEN    = process.env.TELEGRAM_TOKEN  || '';
const TG_CHAT_ID  = process.env.TELEGRAM_CHAT_ID || '';

// TRADE_MODE: "execute" (default) | "analyze" | "dry_run"
const TRADE_MODE  = process.env.TRADE_MODE || 'execute';

// ── Trading Rule Thresholds ────────────────────────────────────────────────────
const RULE_CUT_LOSS_PCT    = -70;  // Hard cut loss — sell immediately
const RULE_DEEP_CUT_PCT    = -50;  // Deep cut loss — sell immediately
const RULE_TAKE_PROFIT_PCT = +30;  // Take profit alert (no auto-sell)
const RULE_DCA_MIN_PCT     = -20;  // DCA zone lower bound
const RULE_DCA_MAX_PCT     = -40;  // DCA zone upper bound (note: -40 < -20)
const MAX_SELLS_PER_RUN    = 3;    // Safety: never liquidate more than 3 per run
const MIN_CASH_FOR_BUY     = 1000; // Skip BUY if cash < 1000 baht

// ── Utility: sleep ─────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── HTTPS helper: returns { statusCode, body } or { error } ───────────────────
function httpsRequest(opts, postBody) {
  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: d }));
    });
    req.on('error', (err) => resolve({ error: err.message }));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ error: 'timeout' });
    });
    if (postBody) req.write(postBody);
    req.end();
  });
}

// ── InnovestX: fetch portfolio ─────────────────────────────────────────────────
async function fetchPortfolio() {
  if (!INVX_KEY || !INVX_SECRET) throw new Error('INVX_KEY or INVX_SECRET not set');

  const opts = {
    hostname: 'trade.innovestx.co.th',
    path: `/api/api-portal/v1/equity/${INVX_KEY}/portfolio`,
    method: 'GET',
    headers: {
      'api-key': INVX_KEY,
      'api-secret': INVX_SECRET,
    },
  };

  const result = await httpsRequest(opts);
  if (result.error) throw new Error('Portfolio fetch failed: ' + result.error);
  if (result.statusCode !== 200) throw new Error(`Portfolio API returned ${result.statusCode}: ${result.body}`);

  try {
    return JSON.parse(result.body);
  } catch (e) {
    throw new Error('Portfolio response parse error: ' + result.body.substring(0, 200));
  }
}

// ── InnovestX: normalize portfolio response ────────────────────────────────────
// Returns array of { sym, qty, avg, mkt, pnlPct, unrealizedPnl }
function normalizePortfolio(raw) {
  const items = Array.isArray(raw)
    ? raw
    : (raw?.data?.positions || raw?.positions || raw?.data || []);

  return items
    .map((p) => {
      const sym = p.symbol || p.ticker || p.Symbol || p.stockCode || '';
      const qty = Number(p.volume || p.quantity || p.Volume || p.availableVolume || 0);
      const avg = Number(p.avgCost || p.avg_cost || p.AvgCost || p.averageCost || 0);
      const mkt = Number(p.lastPrice || p.last || p.Last || p.marketPrice || avg);
      const unrealizedPnl = avg > 0 ? (mkt - avg) * qty : 0;
      const pnlPct = avg > 0 ? ((mkt - avg) / avg) * 100 : 0;
      return { sym, qty, avg, mkt, pnlPct, unrealizedPnl };
    })
    .filter((p) => p.sym && p.qty > 0);
}

// ── InnovestX: get cash balance ────────────────────────────────────────────────
// Returns cash amount in baht (best-effort; returns 0 if unavailable)
function extractCashBalance(raw) {
  try {
    const d = raw?.data || raw;
    return Number(
      d?.cashBalance || d?.cash || d?.availableCash || d?.settledCash || 0
    );
  } catch (e) {
    return 0;
  }
}

// ── InnovestX: place order ─────────────────────────────────────────────────────
async function placeOrder(ticker, side, quantity) {
  if (!INVX_KEY || !INVX_SECRET) throw new Error('Missing INVX credentials');

  const orderBody = {
    ticker,
    side,            // "Buy" or "Sell"
    quantity,
    order_type: 'MP-MTL',
    api_secret: INVX_SECRET,
  };

  // Include PIN if configured
  if (INVX_PIN) orderBody.pin = INVX_PIN;

  const bodyStr = JSON.stringify(orderBody);

  const opts = {
    hostname: 'trade.innovestx.co.th',
    path: `/api/api-portal/v1/equity/${INVX_KEY}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'api-key': INVX_KEY,
      'api-secret': INVX_SECRET,
    },
  };

  const result = await httpsRequest(opts, bodyStr);
  if (result.error) return { success: false, error: result.error };

  try {
    const parsed = JSON.parse(result.body);
    if (result.statusCode === 200 || result.statusCode === 201) {
      return { success: true, orderId: parsed?.orderId || parsed?.order_id || parsed?.data?.orderId || 'OK', raw: parsed };
    }
    return { success: false, statusCode: result.statusCode, error: parsed?.message || parsed?.error || result.body.substring(0, 200) };
  } catch (e) {
    return { success: false, error: 'Response parse error: ' + result.body.substring(0, 200) };
  }
}

// ── Gemini: text summary with retry on 429 ────────────────────────────────────
async function askGemini(prompt) {
  if (!GEMINI_KEY) return null;

  const bodyStr = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 800, temperature: 0.3 },
  });

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const opts = {
      hostname: 'generativelanguage.googleapis.com',
      path: '/v1beta/models/gemini-1.5-flash:generateContent?key=' + GEMINI_KEY,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };

    const result = await httpsRequest(opts, bodyStr);

    if (result.error === 'timeout') {
      if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS); continue; }
      return null;
    }

    if (result.error) {
      if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS); continue; }
      return null;
    }

    if (result.statusCode === 429) {
      console.warn(`[Gemini] 429 rate-limit on attempt ${attempt}`);
      if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS * attempt); continue; }
      return null;
    }

    try {
      const p = JSON.parse(result.body);
      if (p.error) { console.warn('[Gemini] API error:', p.error.message); return null; }
      return p.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch (e) {
      return null;
    }
  }
  return null;
}

// ── Telegram: send message ─────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.log('[Telegram] No credentials — skipping send');
    return;
  }

  const bodyStr = JSON.stringify({
    chat_id: TG_CHAT_ID,
    text: text.substring(0, 4096), // Telegram message limit
    parse_mode: 'HTML',
  });

  const opts = {
    hostname: 'api.telegram.org',
    path: `/bot${TG_TOKEN}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
    },
  };

  const result = await httpsRequest(opts, bodyStr);
  if (result.error) console.warn('[Telegram] Send failed:', result.error);
}

// ── Apply trading rules to a stock ────────────────────────────────────────────
// Returns { action: "SELL_CUT_LOSS"|"SELL_DEEP_CUT"|"TAKE_PROFIT_ALERT"|"DCA_SIGNAL"|"HOLD", reason }
function applyRules(stock) {
  const { pnlPct, qty } = stock;

  if (pnlPct <= RULE_CUT_LOSS_PCT) {
    return { action: 'SELL_CUT_LOSS', reason: `P/L ${pnlPct.toFixed(1)}% <= ${RULE_CUT_LOSS_PCT}% (Hard Cut Loss)` };
  }

  if (pnlPct <= RULE_DEEP_CUT_PCT) {
    return { action: 'SELL_DEEP_CUT', reason: `P/L ${pnlPct.toFixed(1)}% <= ${RULE_DEEP_CUT_PCT}% (Deep Cut)` };
  }

  if (pnlPct >= RULE_TAKE_PROFIT_PCT) {
    return { action: 'TAKE_PROFIT_ALERT', reason: `P/L +${pnlPct.toFixed(1)}% >= +${RULE_TAKE_PROFIT_PCT}% (Take Profit Zone)` };
  }

  // DCA zone: P/L is between -20% and -40% (qty must be > 0, which it always is at this point)
  if (pnlPct <= RULE_DCA_MIN_PCT && pnlPct >= RULE_DCA_MAX_PCT) {
    return { action: 'DCA_SIGNAL', reason: `P/L ${pnlPct.toFixed(1)}% in DCA zone (${RULE_DCA_MAX_PCT}% ~ ${RULE_DCA_MIN_PCT}%)` };
  }

  return { action: 'HOLD', reason: `P/L ${pnlPct.toFixed(1)}% — no action needed` };
}

// ── Core trading logic (shared between autotrade and trigger) ──────────────────
async function runAutoTrader(mode) {
  const result = {
    mode,
    orders_placed: [],
    orders_failed: [],
    analyzed: [],
    alerts: [],
    summary: '',
    timestamp: new Date().toISOString(),
  };

  // 1. Fetch portfolio
  let portfolioRaw;
  try {
    portfolioRaw = await fetchPortfolio();
  } catch (err) {
    const errMsg = `InnovestX portfolio fetch failed: ${err.message}`;
    console.error(errMsg);
    if (mode !== 'dry_run') {
      await sendTelegram(`<b>Auto Trader Error</b>\n${errMsg}`);
    }
    result.summary = errMsg;
    return result;
  }

  const portfolio = normalizePortfolio(portfolioRaw);
  const cashBalance = extractCashBalance(portfolioRaw);

  console.log(`[AutoTrader] Mode: ${mode} | Stocks: ${portfolio.length} | Cash: ${cashBalance}`);

  if (portfolio.length === 0) {
    result.summary = 'Portfolio is empty — nothing to trade.';
    if (mode !== 'dry_run') {
      await sendTelegram('📊 <b>Auto Trader:</b> พอร์ตว่างเปล่า ไม่มีหุ้นที่ต้องจัดการ');
    }
    return result;
  }

  // 2. Analyze each stock and build action lists
  const sellCandidates = [];   // stocks needing sell (cut loss / deep cut)
  const alertCandidates = [];  // take profit / DCA alerts

  for (const stock of portfolio) {
    if (stock.avg <= 0) continue;

    const { action, reason } = applyRules(stock);

    result.analyzed.push({
      sym: stock.sym,
      qty: stock.qty,
      avg: stock.avg,
      mkt: stock.mkt,
      pnlPct: parseFloat(stock.pnlPct.toFixed(2)),
      unrealizedPnl: parseFloat(stock.unrealizedPnl.toFixed(2)),
      action,
      reason,
    });

    if (action === 'SELL_CUT_LOSS' || action === 'SELL_DEEP_CUT') {
      sellCandidates.push({ ...stock, action, reason });
    } else if (action === 'TAKE_PROFIT_ALERT' || action === 'DCA_SIGNAL') {
      alertCandidates.push({ ...stock, action, reason });
    }
  }

  // Sort sell candidates: worst P/L first (most urgent)
  sellCandidates.sort((a, b) => a.pnlPct - b.pnlPct);

  // Safety: cap at MAX_SELLS_PER_RUN
  const sellsToExecute = sellCandidates.slice(0, MAX_SELLS_PER_RUN);

  // 3. Place sell orders (or simulate in analyze/dry_run mode)
  for (const stock of sellsToExecute) {
    const orderInfo = {
      sym: stock.sym,
      side: 'Sell',
      qty: stock.qty,
      reason: stock.reason,
      pnlPct: parseFloat(stock.pnlPct.toFixed(2)),
      mkt: stock.mkt,
    };

    if (mode === 'execute') {
      console.log(`[AutoTrader] Placing SELL: ${stock.sym} x${stock.qty} @ MP-MTL | ${stock.reason}`);
      try {
        const orderResult = await placeOrder(stock.sym, 'Sell', stock.qty);
        if (orderResult.success) {
          result.orders_placed.push({ ...orderInfo, orderId: orderResult.orderId });
          console.log(`[AutoTrader] SELL placed: ${stock.sym} orderId=${orderResult.orderId}`);
        } else {
          result.orders_failed.push({ ...orderInfo, error: orderResult.error });
          console.warn(`[AutoTrader] SELL failed: ${stock.sym} — ${orderResult.error}`);
        }
      } catch (err) {
        result.orders_failed.push({ ...orderInfo, error: err.message });
        console.warn(`[AutoTrader] SELL exception: ${stock.sym} — ${err.message}`);
      }
      // Brief pause between orders to avoid API rate limiting
      await sleep(1000);
    } else {
      // analyze or dry_run: log without placing
      result.orders_placed.push({ ...orderInfo, orderId: 'DRY_RUN', note: 'Not placed — mode is ' + mode });
      console.log(`[AutoTrader][${mode}] Would SELL: ${stock.sym} x${stock.qty} | ${stock.reason}`);
    }
  }

  // 4. Collect alerts (take profit, DCA) — never execute, just notify
  for (const stock of alertCandidates) {
    result.alerts.push({
      sym: stock.sym,
      action: stock.action,
      reason: stock.reason,
      pnlPct: parseFloat(stock.pnlPct.toFixed(2)),
      mkt: stock.mkt,
    });
  }

  // 5. Build summary with AI (falls back to plain text if AI fails)
  const analyzedSummary = result.analyzed
    .map((s) => `${s.sym}: ${s.pnlPct >= 0 ? '+' : ''}${s.pnlPct}% (${s.action})`)
    .join(', ');

  const sellsSummary = sellsToExecute
    .map((s) => `${s.sym} (${s.pnlPct.toFixed(1)}%, ${s.qty} หุ้น)`)
    .join(', ');

  const aiPrompt = `สรุปผลการทำงาน Auto Trader สำหรับพอร์ตหุ้นไทย:
โหมด: ${mode}
วันที่: ${new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}
หุ้นที่วิเคราะห์ทั้งหมด: ${result.analyzed.length} ตัว
หุ้นที่ขาย/จะขาย: ${sellsToExecute.length} ตัว (${sellsSummary || 'ไม่มี'})
รายละเอียด: ${analyzedSummary}
เงินสด: ${cashBalance} บาท

สรุปเป็นภาษาไทยสั้นๆ 3-4 ประโยค บอกสถานะพอร์ต สิ่งที่ทำไป และคำแนะนำสั้นๆ:`;

  const aiSummary = await askGemini(aiPrompt);

  // Build plain-text fallback
  const plainSummary = buildPlainSummary(result, mode, cashBalance);
  result.summary = aiSummary || plainSummary;

  // 6. Send Telegram report (skip in dry_run mode)
  if (mode !== 'dry_run') {
    const tgMsg = buildTelegramMessage(result, mode, cashBalance);
    await sendTelegram(tgMsg);
  } else {
    console.log('[AutoTrader][dry_run] Telegram skipped.');
    console.log('[AutoTrader][dry_run] Summary:', result.summary);
  }

  return result;
}

// ── Build plain-text summary (AI fallback) ────────────────────────────────────
function buildPlainSummary(result, mode, cashBalance) {
  const lines = [];
  lines.push(`Auto Trader รัน [${mode.toUpperCase()}] | ${result.analyzed.length} หุ้นถูกวิเคราะห์`);

  if (result.orders_placed.length > 0) {
    const sold = result.orders_placed.filter((o) => o.orderId !== 'DRY_RUN');
    const simulated = result.orders_placed.filter((o) => o.orderId === 'DRY_RUN');
    if (sold.length > 0) lines.push(`ขายแล้ว: ${sold.map((o) => `${o.sym} (${o.pnlPct}%)`).join(', ')}`);
    if (simulated.length > 0) lines.push(`จะขาย (${mode}): ${simulated.map((o) => `${o.sym} (${o.pnlPct}%)`).join(', ')}`);
  } else {
    lines.push('ไม่มีหุ้นถึงเกณฑ์ Cut Loss');
  }

  if (result.orders_failed.length > 0) {
    lines.push(`ขายไม่สำเร็จ: ${result.orders_failed.map((o) => `${o.sym} (${o.error})`).join(', ')}`);
  }

  if (result.alerts.length > 0) {
    lines.push(`แจ้งเตือน: ${result.alerts.map((a) => `${a.sym} ${a.action}`).join(', ')}`);
  }

  lines.push(`เงินสด: ${cashBalance.toLocaleString()} บาท`);
  return lines.join('\n');
}

// ── Build Telegram HTML message ────────────────────────────────────────────────
function buildTelegramMessage(result, mode, cashBalance) {
  const now = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'short' });
  const modeLabel = mode === 'execute' ? '⚡ EXECUTE' : '🔍 ANALYZE';

  let msg = `<b>Auto Trader Report</b> ${modeLabel}\n`;
  msg += `<i>${now} (BKK)</i>\n`;
  msg += `${'─'.repeat(28)}\n\n`;

  // Portfolio overview
  msg += `<b>พอร์ตทั้งหมด (${result.analyzed.length} หุ้น)</b>\n`;
  for (const s of result.analyzed) {
    const pnlSign = s.pnlPct >= 0 ? '+' : '';
    const icon = s.action === 'SELL_CUT_LOSS' ? '🔴' :
                 s.action === 'SELL_DEEP_CUT'  ? '🟠' :
                 s.action === 'TAKE_PROFIT_ALERT' ? '🟢' :
                 s.action === 'DCA_SIGNAL'     ? '🔵' : '⚪';
    msg += `${icon} <b>${s.sym}</b> ${pnlSign}${s.pnlPct}% | ทุน ${s.avg} | ราคา ${s.mkt}\n`;
  }
  msg += '\n';

  // Orders placed
  if (result.orders_placed.length > 0) {
    const verb = mode === 'execute' ? 'ขายแล้ว' : 'จะขาย';
    msg += `<b>${verb} (${result.orders_placed.length} รายการ)</b>\n`;
    for (const o of result.orders_placed) {
      const icon = mode === 'execute' ? '✅' : '📋';
      msg += `${icon} ${o.sym} x${o.qty} หุ้น @ MP-MTL\n`;
      msg += `   เหตุผล: ${o.reason}\n`;
      if (mode === 'execute' && o.orderId !== 'DRY_RUN') {
        msg += `   Order ID: ${o.orderId}\n`;
      }
    }
    msg += '\n';
  }

  // Failed orders
  if (result.orders_failed.length > 0) {
    msg += `<b>ขายไม่สำเร็จ (${result.orders_failed.length} รายการ)</b>\n`;
    for (const o of result.orders_failed) {
      msg += `❌ ${o.sym} — ${o.error}\n`;
    }
    msg += '\n';
  }

  // Alerts
  if (result.alerts.length > 0) {
    msg += `<b>แจ้งเตือน (${result.alerts.length} รายการ)</b>\n`;
    for (const a of result.alerts) {
      const icon = a.action === 'TAKE_PROFIT_ALERT' ? '💰' : '📉';
      msg += `${icon} ${a.sym}: ${a.reason}\n`;
    }
    msg += '\n';
  }

  // No action needed
  const noActionCount = result.analyzed.filter((s) => s.action === 'HOLD').length;
  if (noActionCount > 0) {
    msg += `<b>ถือต่อ:</b> ${result.analyzed.filter((s) => s.action === 'HOLD').map((s) => s.sym).join(', ')}\n\n`;
  }

  // AI summary or plain summary
  msg += `<b>สรุป AI:</b>\n${result.summary || 'ไม่มีสรุป'}\n\n`;

  // Footer
  msg += `<i>เงินสด: ${cashBalance.toLocaleString()} บาท | Max ${MAX_SELLS_PER_RUN} sells/run</i>`;

  return msg;
}

// ── Netlify Scheduled Handler ──────────────────────────────────────────────────
exports.handler = async (event) => {
  console.log('[AutoTrader] Scheduled run triggered');
  console.log('[AutoTrader] Trade mode:', TRADE_MODE);

  if (!INVX_KEY || !INVX_SECRET) {
    const errMsg = 'Missing INVX_KEY or INVX_SECRET — cannot run Auto Trader';
    console.error(errMsg);
    return { statusCode: 500, body: errMsg };
  }

  try {
    const result = await runAutoTrader(TRADE_MODE);
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Auto Trader completed',
        mode: result.mode,
        sold: result.orders_placed.length,
        failed: result.orders_failed.length,
        analyzed: result.analyzed.length,
      }),
    };
  } catch (err) {
    const errMsg = `[AutoTrader] Fatal error: ${err.message}`;
    console.error(errMsg);
    try {
      if (TRADE_MODE !== 'dry_run') {
        await sendTelegram(`<b>Auto Trader Fatal Error</b>\n${err.message}`);
      }
    } catch (tgErr) {
      console.error('[Telegram] Failed to send error notification:', tgErr.message);
    }
    return { statusCode: 500, body: errMsg };
  }
};

// Export runAutoTrader for use by autotrader-trigger.js
module.exports.runAutoTrader = runAutoTrader;
