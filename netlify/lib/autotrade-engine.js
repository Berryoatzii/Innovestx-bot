// Research-only portfolio advisory engine.
//
// This file has deliberately zero broker credential, account-login, or order
// transport code. Verified portfolio data must be supplied by the caller after
// it has been read through the official local SDK V2 gateway. Every output is
// an observation marked SIMULATE; only the separate signed human-approval flow
// can create an order intent.

const MAX_REVIEW_SIGNALS_PER_RUN = 3;
const DEEP_LOSS_REVIEW_PCT = -50;
const TRADE_MODE = 'dry_run';

function normalizePortfolio(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const sym = String(item.sym || item.symbol || '').toUpperCase().trim();
    const qty = Number(item.qty ?? item.actualVolume ?? item.volume ?? item.quantity ?? 0);
    const avg = Number(item.avg ?? item.averagePrice ?? item.avgCost ?? 0);
    const mkt = Number(item.mkt ?? item.marketPrice ?? item.lastPrice ?? item.last ?? 0);
    const valid = /^[A-Z0-9._-]{1,20}$/.test(sym)
      && Number.isFinite(qty) && qty > 0
      && Number.isFinite(avg) && avg > 0
      && Number.isFinite(mkt) && mkt > 0;
    if (!valid) return null;
    const pnlPct = ((mkt - avg) / avg) * 100;
    return { sym, qty, avg, mkt, pnlPct, unrealizedPnl: (mkt - avg) * qty };
  }).filter(Boolean);
}

function emptyResult(mode, summary) {
  return {
    mode,
    orders_placed: [],
    orders_failed: [],
    analyzed: [],
    alerts: [],
    regime: null,
    summary,
    timestamp: new Date().toISOString(),
    advisoryOnly: true,
  };
}

async function runAutoTrader(mode = 'dry_run', portfolioOverride = null) {
  const normalizedMode = String(mode || '').toLowerCase();
  if (normalizedMode === 'execute') {
    throw new Error('DIRECT_EXECUTE_DISABLED_USE_HUMAN_APPROVAL');
  }

  if (!Array.isArray(portfolioOverride) || portfolioOverride.length === 0) {
    return emptyResult('dry_run', 'Portfolio input required from secure SDK gateway');
  }

  const portfolio = normalizePortfolio(portfolioOverride);
  const result = emptyResult('dry_run', '');
  if (portfolio.length === 0) {
    result.summary = 'Portfolio input contained no valid positions';
    return result;
  }

  result.analyzed = portfolio.map((stock) => {
    const needsReview = stock.pnlPct <= DEEP_LOSS_REVIEW_PCT;
    return {
      sym: stock.sym,
      qty: stock.qty,
      avg: stock.avg,
      mkt: stock.mkt,
      pnlPct: Number(stock.pnlPct.toFixed(2)),
      grade: needsReview ? 'C' : 'B',
      final_score: needsReview ? 30 : 50,
      action: needsReview ? 'REVIEW' : 'HOLD',
      reason_th: needsReview
        ? 'ขาดทุนลึก ควรตรวจพื้นฐานและสภาพคล่องก่อนตัดสินใจ'
        : 'ยังไม่มีข้อมูลพื้นฐานและตลาดเพียงพอให้เสนอซื้อขาย',
      cut_eligible: false,
      dca_eligible: false,
      authority: 'ADVISORY_ONLY',
    };
  });

  const reviewSignals = result.analyzed
    .filter((item) => item.action === 'REVIEW')
    .sort((a, b) => a.pnlPct - b.pnlPct)
    .slice(0, MAX_REVIEW_SIGNALS_PER_RUN);

  result.orders_placed = reviewSignals.map((item) => ({
    sym: item.sym,
    side: 'Sell',
    qty: item.qty,
    grade: item.grade,
    final_score: item.final_score,
    pnlPct: item.pnlPct,
    mkt: item.mkt,
    reason: item.reason_th,
    orderId: 'SIMULATE',
    note: 'Advisory review only; no order was sent',
  }));
  result.summary = result.orders_placed.length
    ? `${result.orders_placed.length} position(s) require human review; no order sent`
    : 'No review threshold reached; no order sent';
  return result;
}

exports.handler = async () => {
  const result = await runAutoTrader(TRADE_MODE, null);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      ok: true,
      mode: result.mode,
      advisoryOnly: true,
      summary: result.summary,
      liveOrdersPlaced: 0,
    }),
  };
};

module.exports.runAutoTrader = runAutoTrader;
module.exports._test = { normalizePortfolio };
