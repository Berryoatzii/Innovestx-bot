const {
  workerAuthorized,
  claimNextIntent,
  markAttempt,
  reportPrecheckFailure,
  reportSubmission,
  reportReconciliation,
  nextReconciliation,
} = require('../lib/private-worker-queue');

const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function response(statusCode, body) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

function parseBody(event) {
  try { return JSON.parse(event.body || '{}'); }
  catch { return {}; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return response(405, { error: 'POST_REQUIRED' });
  if (!workerAuthorized(event.headers)) return response(401, { error: 'PRIVATE_WORKER_UNAUTHORIZED' });
  const input = parseBody(event);
  const workerId = String(input.workerId || '');
  const action = String(input.action || 'claim').toLowerCase();
  try {
    if (action === 'claim') {
      const claim = await claimNextIntent(workerId, event);
      return response(200, claim ? { ok: true, claim } : { ok: true, claim: null });
    }
    if (action === 'reconcile-next') {
      const pending = await nextReconciliation(workerId, event);
      return response(200, { ok: true, pending });
    }
    if (action === 'mark-attempt') {
      const intent = await markAttempt(input, workerId, event);
      return response(200, { ok: true, status: intent.status });
    }
    if (action === 'precheck-failed') {
      const intent = await reportPrecheckFailure(input, workerId, event);
      return response(200, { ok: true, status: intent.status });
    }
    if (action === 'submission') {
      const intent = await reportSubmission(input, workerId, event);
      return response(200, { ok: true, status: intent.status });
    }
    if (action === 'reconcile') {
      const intent = await reportReconciliation(input, workerId, event);
      return response(200, { ok: true, status: intent.status });
    }
    return response(400, { error: 'UNSUPPORTED_ACTION' });
  } catch (error) {
    return response(409, { error: String(error.message || error).slice(0, 300), safeDefault: true });
  }
};

module.exports._test = { parseBody };
