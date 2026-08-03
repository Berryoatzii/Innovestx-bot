function parseManualBlocks(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [symbol, date, type = 'MANUAL_BLOCK'] = item.split(':');
      return {
        symbol: String(symbol || '').toUpperCase(),
        date: String(date || ''),
        type: String(type || 'MANUAL_BLOCK').toUpperCase(),
        source: 'ENV_MANUAL_BLOCK',
      };
    })
    .filter((item) => item.symbol && /^\d{4}-\d{2}-\d{2}$/.test(item.date));
}

function dateDistanceDays(a, b) {
  const left = new Date(`${a}T00:00:00.000Z`).getTime();
  const right = new Date(`${b}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Infinity;
  return Math.round(Math.abs(left - right) / 86400000);
}

function corporateActionGate({
  symbol,
  date,
  researchEvents = [],
  env = process.env,
  windowDays = 2,
}) {
  const normalizedSymbol = String(symbol || '').toUpperCase().trim();
  const normalizedDate = String(date || '').slice(0, 10);
  if (!normalizedSymbol || !/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
    return { allowed: false, reason: 'INVALID_CORPORATE_ACTION_INPUT', events: [] };
  }

  const manual = parseManualBlocks(env.CORPORATE_ACTION_BLOCKS)
    .filter((item) => item.symbol === normalizedSymbol);
  const research = (Array.isArray(researchEvents) ? researchEvents : [])
    .filter((item) => item?.date && item?.type)
    .map((item) => ({ ...item, symbol: normalizedSymbol, source: item.source || 'RESEARCH_HISTORY' }));
  const relevant = [...manual, ...research]
    .filter((item) => dateDistanceDays(item.date, normalizedDate) <= Number(windowDays));

  if (relevant.length > 0) {
    return {
      allowed: false,
      reason: 'CORPORATE_ACTION_WINDOW',
      events: relevant,
    };
  }

  const confirmedThrough = String(env.CORPORATE_ACTIONS_CONFIRMED_THROUGH || '');
  const requireConfirmation = env.REQUIRE_CORPORATE_ACTION_CONFIRMATION !== 'false';
  if (requireConfirmation && (!/^\d{4}-\d{2}-\d{2}$/.test(confirmedThrough) || confirmedThrough < normalizedDate)) {
    return {
      allowed: false,
      reason: 'CORPORATE_ACTION_STATUS_UNCONFIRMED',
      events: [],
      confirmedThrough: confirmedThrough || null,
    };
  }

  return {
    allowed: true,
    reason: 'CORPORATE_ACTION_CLEAR',
    events: [],
    confirmedThrough: confirmedThrough || null,
  };
}

module.exports = {
  parseManualBlocks,
  corporateActionGate,
  _test: { dateDistanceDays },
};
