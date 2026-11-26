// Диапазон для доли («из N кликов M заказов», «из N заказов M выкуплено»).
// Интервал Уилсона, 90%: истинная доля с вероятностью 90% лежит между low и high.
// Чем меньше данных, тем шире диапазон — так честнее, чем одна «точная» цифра по 8 заказам.
export const Z90 = 1.645;

export function wilson(successes, total, z = Z90) {
  if (!total || total <= 0 || successes == null) return null;
  const p = Math.min(1, Math.max(0, successes / total));
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  return { p, low: Math.max(0, center - half), high: Math.min(1, center + half), n: total };
}

// Оценка конверсии, которая подстраивается под спрос (так делают системы управления ставками):
//  1) свежие дни весят больше: вес дня = 0,5^(возраст / период полураспада), по умолчанию 7 дней —
//     если спрос или конверсия изменились, оценка за 1–2 недели переключается на новые цифры;
//  2) пока данных мало, оценку «держит» конверсия самой карточки (байесовская оценка с априорной долей):
//     prior как будто `priorWeight` кликов с конверсией карточки. Чем больше своих кликов, тем меньше её влияние.
//  rows: [{ date, clicks, orders }], today — 'YYYY-MM-DD'.
export function decayedRate(rows, today, { halfLifeDays = 7, prior = null, priorWeight = 50 } = {}) {
  const t = Date.parse(today);
  let c = 0;
  let o = 0;
  let rawC = 0;
  let rawO = 0;
  for (const r of rows) {
    const age = Math.max(0, (t - Date.parse(r.date)) / 86400000);
    const w = Math.pow(0.5, age / halfLifeDays);
    c += (r.clicks || 0) * w;
    o += (r.orders || 0) * w;
    rawC += r.clicks || 0;
    rawO += r.orders || 0;
  }
  const k = prior != null ? priorWeight : 0;
  const total = c + k;
  if (total <= 0) return null;
  const succ = o + (prior != null ? prior * k : 0);
  const w = wilson(succ, total);
  return { rate: succ / total, low: w.low, high: w.high, weightedClicks: c, weightedOrders: o, clicks: rawC, orders: rawO, priorUsed: prior != null };
}
