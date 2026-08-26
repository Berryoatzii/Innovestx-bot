// Canonical Settrade V2 equity order states.
// Official short codes include S/SX (submitted/accepted), M (fully matched)
// and MP (partially matched). Unknown short codes stay uncertain until
// InnovestX/Streaming confirms their exact meaning.

function normalizeBrokerOrderState(orderOrStatus = {}) {
  const order = typeof orderOrStatus === 'object' && orderOrStatus !== null
    ? orderOrStatus
    : { status: orderOrStatus };
  const status = String(order.status || '').trim().toUpperCase();
  const matched = Number(order.matchedQuantity ?? order.matched ?? order.matchQty ?? 0);
  const quantity = Number(order.quantity ?? order.volume ?? order.vol ?? order.qty ?? 0);

  if (quantity > 0 && matched >= quantity) return 'FILLED';
  if (status.includes('REJECT')) return 'REJECTED_BY_BROKER';
  if (status.includes('CANCEL')) return 'CANCELLED';
  if (status.includes('EXPIRE')) return 'EXPIRED_BY_BROKER';
  if (matched > 0 || status === 'MP' || status.includes('PART')) return 'PARTIALLY_FILLED';
  if (status === 'M' || status.includes('FILL') || status.includes('MATCHED')) return 'FILLED';
  if (status === 'S' || status === 'SX' || status.includes('PENDING') || status.includes('ACK')) {
    return 'ACKNOWLEDGED';
  }
  return 'EXECUTION_UNCERTAIN';
}

function isBrokerOrderTerminal(orderOrStatus = {}) {
  return new Set([
    'FILLED',
    'REJECTED_BY_BROKER',
    'CANCELLED',
    'EXPIRED_BY_BROKER',
  ]).has(normalizeBrokerOrderState(orderOrStatus));
}

module.exports = { normalizeBrokerOrderState, isBrokerOrderTerminal };
