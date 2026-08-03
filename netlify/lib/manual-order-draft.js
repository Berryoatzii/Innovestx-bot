const { handler: invxHandler } = require('../functions/invx');
const { fetchBrokerPortfolio } = require('./broker-portfolio');
const { getClassification } = require('./portfolio-classification-store');
const { loadEffectivePortfolioPolicy } = require('./effective-portfolio-policy');
const { createIntent } = require('./order-intent-store');
const { roundToTick, tickSize } = require('./portfolio-action-plan');

const MANUAL_DRAFT_VERSION = 'TELEGRAM_MANUAL_LIMIT_V1.0.0';

function normalizeSymbol(symbol) {
  const value = String(symbol || '').toUpperCase().trim();
  if (!/^[A-Z0-9._-]{1,20}$/.test(value)) throw new Error('รูปแบบชื่อหุ้นไม่ถูกต้อง');
  return value;
}

function normalizeSide(side) {
  const value = String(side || '').toUpperCase().trim();
  if (!['BUY', 'SELL'].includes(value)) throw new Error('คำสั่งต้องเป็น BUY หรือ SELL');
  return value;
}

function totalPortfolioValue(portfolio, cash) {
  return Number(cash || 0) + (Array.isArray(portfolio) ? portfolio : []).reduce((sum, item) => {
    return sum + Number(item.qty || 0) * Number(item.mkt || 0);
  }, 0);
}

function validateDraftInput(input, options = {}) {
  const side = normalizeSide(input.side);
  const symbol = normalizeSymbol(input.symbol);
  const quantity = Math.floor(Number(input.quantity || 0));
  const price = Number(input.price || 0);
  const boardLot = Math.max(1, Math.floor(Number(options.boardLot || 100)));
  const maxOrderValue = Number(options.maxOrderValue || 3000);

  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('จำนวนหุ้นต้องมากกว่า 0');
  if (quantity % boardLot !== 0) throw new Error(`จำนวนหุ้นต้องเป็นจำนวนเต็มล็อต ล็อตละ ${boardLot} หุ้น`);
  if (!Number.isFinite(price) || price <= 0) throw new Error('ราคาต้องมากกว่า 0');

  const suggestedPrice = roundToTick(price);
  const tolerance = Math.max(0.000001, tickSize(price) / 1000);
  if (Math.abs(price - suggestedPrice) > tolerance) {
    throw new Error(`ราคาไม่ตรง Tick Size ราคาที่ใกล้ที่สุดคือ ${suggestedPrice.toFixed(2)} บาท`);
  }

  const estimatedValue = Number((quantity * suggestedPrice).toFixed(2));
  if (!(maxOrderValue > 0) || estimatedValue > maxOrderValue) {
    throw new Error(`มูลค่าร่างออเดอร์ ${estimatedValue.toLocaleString('th-TH')} บาท เกินวงเงิน ${maxOrderValue.toLocaleString('th-TH')} บาท`);
  }

  return { side, symbol, quantity, price: suggestedPrice, boardLot, estimatedValue };
}

async function fetchQuote(symbol, event) {
  const response = await invxHandler({
    httpMethod: 'GET',
    headers: {},
    queryStringParameters: { action: 'quote', sym: symbol },
    body: '',
    requestContext: event?.requestContext,
  });
  let payload = {};
  try { payload = JSON.parse(response.body || '{}'); } catch {}
  if (response.statusCode !== 200 || Number(payload.last || 0) <= 0) {
    throw new Error(`อ่านราคาตลาด ${symbol} ไม่สำเร็จ`);
  }
  return {
    last: Number(payload.last || 0),
    bid: Number(payload.bid || 0),
    ask: Number(payload.ask || 0),
    high: Number(payload.high || 0),
    low: Number(payload.low || 0),
  };
}

async function createManualOrderDraft(input, event = {}, options = {}) {
  const boardLot = Number(process.env.PROPOSAL_BOARD_LOT || 100);
  const maxOrderValue = Number(process.env.MANUAL_DRAFT_MAX_ORDER_VALUE || 3000);
  const validated = validateDraftInput(input, { boardLot, maxOrderValue });
  const broker = await fetchBrokerPortfolio(event);
  const classification = await getClassification(validated.symbol, event);

  if (!classification?.explicit) {
    throw new Error(`${validated.symbol} ยังไม่ได้จัดหมวด กรุณาใช้ /setup ก่อน`);
  }
  if (classification.bucket !== 'ACTIVE') {
    throw new Error(`${validated.symbol} อยู่หมวด ${classification.bucket} ร่างออเดอร์ด้วยคำสั่งนี้อนุญาตเฉพาะ ACTIVE`);
  }

  const quote = await fetchQuote(validated.symbol, event);
  const distancePct = Math.abs(validated.price - quote.last) / quote.last;
  const maxDistancePct = Number(process.env.MAX_RESTING_LIMIT_DISTANCE_PCT || 0.15);
  if (!Number.isFinite(distancePct) || distancePct > maxDistancePct) {
    throw new Error(`ราคาที่ตั้งห่างจากตลาด ${(distancePct * 100).toFixed(1)}% เกินเพดาน ${(maxDistancePct * 100).toFixed(0)}%`);
  }

  const position = broker.portfolio.find((item) => String(item.sym || '').toUpperCase() === validated.symbol);
  const heldQty = Math.floor(Number(position?.qty || 0));
  const portfolioValue = totalPortfolioValue(broker.portfolio, broker.cash);
  const { policy } = await loadEffectivePortfolioPolicy(event);

  if (validated.side === 'SELL') {
    if (!position || heldQty <= 0) throw new Error(`ไม่พบ ${validated.symbol} ในพอร์ต`);
    if (validated.quantity >= heldQty) throw new Error('ห้ามขายหมดสถานะในร่างออเดอร์ครั้งเดียว');
    const maxFraction = Number(process.env.MAX_LIVE_POSITION_FRACTION || 0.25);
    const maxQty = Math.floor((heldQty * maxFraction) / boardLot) * boardLot;
    if (validated.quantity > maxQty || maxQty <= 0) {
      throw new Error(`ขายได้สูงสุด ${Math.max(0, maxQty)} หุ้นต่อร่าง ตามเพดาน ${(maxFraction * 100).toFixed(0)}%`);
    }
  }

  if (validated.side === 'BUY') {
    const cashReserve = Math.max(
      Number(process.env.MIN_LIVE_CASH_RESERVE || 5000),
      portfolioValue * Number(policy.targets.CASH || 0.20)
    );
    const costBuffer = validated.estimatedValue * 0.01;
    if (Number(broker.cash || 0) - validated.estimatedValue - costBuffer < cashReserve) {
      throw new Error(`ซื้อแล้วเงินสดจะต่ำกว่าเงินสำรองเป้าหมาย ${cashReserve.toLocaleString('th-TH', { maximumFractionDigits: 0 })} บาท`);
    }

    const currentValue = position ? heldQty * Number(position.mkt || quote.last) : 0;
    const postTradeWeight = portfolioValue > 0
      ? (currentValue + validated.estimatedValue) / portfolioValue
      : 1;
    const maxWeight = Number(process.env.MAX_LIVE_ACTIVE_POSITION_WEIGHT || 0.05);
    if (postTradeWeight > maxWeight) {
      throw new Error(`น้ำหนัก ${validated.symbol} หลังซื้อจะ ${(postTradeWeight * 100).toFixed(1)}% เกินเพดาน ${(maxWeight * 100).toFixed(0)}%`);
    }
  }

  const now = options.now || new Date();
  const idempotencyKey = [
    'TELEGRAM_MANUAL_LIMIT',
    now.toISOString(),
    validated.side,
    validated.symbol,
    validated.quantity,
    validated.price.toFixed(2),
    options.actor || 'operator',
  ].join('|');

  const { intent, created } = await createIntent({
    idempotencyKey,
    symbol: validated.symbol,
    side: validated.side,
    quantity: validated.quantity,
    proposedPrice: validated.price,
    portfolioQty: heldQty,
    portfolioBucket: classification.bucket,
    strategyVersion: MANUAL_DRAFT_VERSION,
    orderStyle: 'RESTING_LIMIT',
    reasonCode: 'TELEGRAM_MANUAL_LIMIT_DRAFT',
    reason: `ผู้ใช้ตั้ง Limit ${validated.side} ${validated.quantity} หุ้น ที่ ${validated.price.toFixed(2)} บาท`,
    modelAuthority: 'NONE',
    decisionAuthority: 'HUMAN_OPERATOR_LIMIT_DRAFT_PLUS_RISK_APPROVAL',
    source: 'telegram-manual-draft',
  }, {
    event,
    now,
    ttlMinutes: Number(process.env.MANUAL_DRAFT_TTL_MINUTES || 120),
  });

  return {
    created,
    intent,
    quote,
    classification,
    distancePct,
    brokerCash: Number(broker.cash || 0),
  };
}

function formatManualDraft(result) {
  const intent = result.intent;
  return [
    `📝 ร่าง LIMIT ${intent.side} [${intent.id}]`,
    `${intent.symbol} ${intent.quantity.toLocaleString('th-TH')} หุ้น`,
    `ราคาที่ตั้ง: ${Number(intent.proposedPrice).toFixed(2)} บาท`,
    `ราคาตลาดล่าสุด: ${Number(result.quote.last).toFixed(2)} | Bid ${Number(result.quote.bid || 0).toFixed(2)} | Ask ${Number(result.quote.ask || 0).toFixed(2)}`,
    `มูลค่าโดยประมาณ: ${Number(intent.estimatedValue).toLocaleString('th-TH')} บาท`,
    `หมวด: ${intent.portfolioBucket} | ห่างตลาด ${(result.distancePct * 100).toFixed(1)}%`,
    `หมดอายุ: ${new Date(intent.expiresAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}`,
    '',
    'กดอนุมัติแล้วระบบจะตรวจเวลาเปิดตลาด ราคา พอร์ต เงินสด Spread ออเดอร์ซ้ำ และวงเงินอีกครั้ง',
    '🔒 ข้อความนี้ยังไม่ใช่ออเดอร์ และการซื้อขายจริงยังขึ้นกับ Live Pilot Lock',
  ].join('\n');
}

module.exports = {
  MANUAL_DRAFT_VERSION,
  normalizeSymbol,
  normalizeSide,
  validateDraftInput,
  totalPortfolioValue,
  createManualOrderDraft,
  formatManualDraft,
};