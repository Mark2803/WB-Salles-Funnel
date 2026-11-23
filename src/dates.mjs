// Даты по московскому времени (WB считает сутки по Москве). Формат дат — YYYY-MM-DD.
const MSK_OFFSET_MS = 3 * 3600_000;

export function todayMsk(now = Date.now()) {
  return new Date(now + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

export function mskHour(now = Date.now()) {
  return new Date(now + MSK_OFFSET_MS).getUTCHours();
}

export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000);
}

export function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}
