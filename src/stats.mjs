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
