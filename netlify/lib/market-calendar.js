const holiday2026 = require('../../config/set-holidays-2026.json');

function bkkDateParts(date = new Date()) {
  const shifted = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return {
    isoDate: shifted.toISOString().slice(0, 10),
    weekday: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    year: shifted.getUTCFullYear(),
  };
}

function loadHolidaySet(year, env = process.env) {
  const manual = String(env.SET_HOLIDAYS_OVERRIDE || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (manual.length > 0) return new Set(manual);
  if (Number(year) === 2026) return new Set(holiday2026.holidays);
  return null;
}

function isSetTradingDay(date = new Date(), env = process.env) {
  const parts = bkkDateParts(date);
  if (parts.weekday === 0 || parts.weekday === 6) {
    return { openDay: false, reason: 'WEEKEND', ...parts };
  }
  const holidays = loadHolidaySet(parts.year, env);
  if (!holidays) return { openDay: false, reason: 'HOLIDAY_CALENDAR_UNKNOWN', ...parts };
  if (holidays.has(parts.isoDate)) return { openDay: false, reason: 'SET_HOLIDAY', ...parts };
  return { openDay: true, reason: 'SET_TRADING_DAY', ...parts };
}

function isContinuousSession(date = new Date(), env = process.env) {
  const day = isSetTradingDay(date, env);
  if (!day.openDay) return { open: false, reason: day.reason, ...day };
  const open =
    (day.minutes >= 10 * 60 + 5 && day.minutes <= 12 * 60 + 25) ||
    (day.minutes >= 14 * 60 + 5 && day.minutes <= 16 * 60 + 20);
  return { open, reason: open ? 'CONTINUOUS_SESSION' : 'OUTSIDE_CONTINUOUS_SESSION', ...day };
}

function isResearchWindow(date = new Date(), env = process.env) {
  const day = isSetTradingDay(date, env);
  if (!day.openDay) return { allowed: false, reason: day.reason, ...day };
  const allowed = day.minutes >= 16 * 60 + 45 && day.minutes <= 23 * 60 + 59;
  return { allowed, reason: allowed ? 'POST_CLOSE_RESEARCH_WINDOW' : 'OUTSIDE_RESEARCH_WINDOW', ...day };
}

module.exports = {
  bkkDateParts,
  loadHolidaySet,
  isSetTradingDay,
  isContinuousSession,
  isResearchWindow,
};
