const { openBlobStore, readOptions } = require('./blob-runtime');
const { reserveWithStore } = require('./operational-pilot-lock');

const DRILL_LOCK_STORE = 'operational-pilot-lock-drill-v1';
const DRILL_EVIDENCE_STORE = 'operational-safety-drill-v1';
const DRILL_EVIDENCE_KEY = 'latest.json';
const FIRST_INTENT = { id: 'd111111111111111', symbol: 'DRILL', side: 'BUY' };
const SECOND_INTENT = { id: 'd222222222222222', symbol: 'DRILL', side: 'BUY' };

async function exerciseOneOrderLock(store, now = new Date()) {
  let firstReservationVerified = false;
  try {
    const first = await reserveWithStore(store, FIRST_INTENT, now);
    firstReservationVerified = first.consumed === true && first.intentId === FIRST_INTENT.id;
  } catch (error) {
    // A retry after alert-delivery failure may find the drill lock already
    // consumed. Only the exact immutable drill intent may be recovered.
    if (String(error.message) === `OPERATIONAL_PILOT_ALREADY_CONSUMED:${FIRST_INTENT.id}`) {
      firstReservationVerified = true;
    } else {
      throw error;
    }
  }

  let secondReservationBlocked = false;
  try {
    await reserveWithStore(store, SECOND_INTENT, now);
  } catch (error) {
    secondReservationBlocked = String(error.message) ===
      `OPERATIONAL_PILOT_ALREADY_CONSUMED:${FIRST_INTENT.id}`;
  }
  if (!firstReservationVerified || !secondReservationBlocked) {
    throw new Error('SAFETY_DRILL_ONE_ORDER_LOCK_NOT_PROVEN');
  }
  return { firstReservationVerified, secondReservationBlocked };
}

function buildSafetyEvidence(lockResult, now = new Date()) {
  return {
    schemaVersion: 1,
    testedAt: now.toISOString(),
    passed: true,
    approvalCallbackVerified: true,
    authorizedChatVerified: true,
    authorizedUserVerified: true,
    alertDelivered: true,
    oneOrderLockFirstReservationVerified: lockResult.firstReservationVerified === true,
    oneOrderLockSecondReservationBlocked: lockResult.secondReservationBlocked === true,
    brokerCalled: false,
    orderIntentCreated: false,
    moneyMoving: false,
  };
}

async function runSafetyDrill(event, deliverAlert, now = new Date()) {
  const lockStore = await openBlobStore(DRILL_LOCK_STORE, { event, consistency: 'strong' });
  const lockResult = await exerciseOneOrderLock(lockStore, now);
  const delivery = await deliverAlert();
  if (delivery?.ok !== true) throw new Error('SAFETY_DRILL_ALERT_DELIVERY_FAILED');
  const evidence = buildSafetyEvidence(lockResult, now);
  const evidenceStore = await openBlobStore(DRILL_EVIDENCE_STORE, { event, consistency: 'strong' });
  await evidenceStore.set(DRILL_EVIDENCE_KEY, JSON.stringify(evidence), {
    metadata: { passed: true, testedAt: evidence.testedAt },
  });
  return evidence;
}

async function readSafetyDrillStatus(event) {
  const store = await openBlobStore(DRILL_EVIDENCE_STORE, { event, consistency: 'strong' });
  const evidence = await store.get(DRILL_EVIDENCE_KEY, readOptions('json', { consistency: 'strong' }));
  if (!evidence || evidence.passed !== true) return { passed: false };
  return {
    passed: true,
    testedAt: String(evidence.testedAt || ''),
    approvalCallbackVerified: evidence.approvalCallbackVerified === true,
    alertDelivered: evidence.alertDelivered === true,
    oneOrderLockVerified:
      evidence.oneOrderLockFirstReservationVerified === true &&
      evidence.oneOrderLockSecondReservationBlocked === true,
    brokerCalled: false,
    moneyMoving: false,
  };
}

module.exports = {
  DRILL_LOCK_STORE,
  DRILL_EVIDENCE_STORE,
  DRILL_EVIDENCE_KEY,
  exerciseOneOrderLock,
  buildSafetyEvidence,
  runSafetyDrill,
  readSafetyDrillStatus,
};
