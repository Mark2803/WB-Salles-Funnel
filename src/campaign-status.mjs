// Статус рекламной кампании «по факту».
// WB по API иногда отдаёт «на паузе» (11) у кампании, которая в кабинете активна и тратит бюджет
// (замечено 25.11.2026: кампания 42174321 — в кабинете «Активна», в API статус 11 и пустая дата запуска,
// а бюджет за день уменьшился с 470 до 374 ₽). Поэтому «на паузе» по API, но с недавним списанием — считаем активной.

export const STATUS_LABEL = { 4: 'готова к запуску', 7: 'завершена', 8: 'отменена', 9: 'активна', 11: 'на паузе' };
const RECENT_MS = 3 * 3600_000; // списание из бюджета за последние 3 часа

/** row — строка таблицы campaigns. Возвращает { status, label, apiStatus, byFact }. */
export function effectiveStatus(row, db, now = Date.now()) {
  const apiStatus = row.status;
  if (apiStatus !== 11) return { status: apiStatus, label: STATUS_LABEL[apiStatus] || String(apiStatus), apiStatus, byFact: false };
  let spending = row.budget_spent_at && now - Date.parse(row.budget_spent_at) <= RECENT_MS;
  if (!spending && !row.budget_spent_at && db) {
    // Списание ещё ни разу не замечали (первый сбор) — смотрим расход за сегодня
    const today = new Date(now + 3 * 3600_000).toISOString().slice(0, 10);
    const r = db.prepare('SELECT COALESCE(SUM(spend), 0) s FROM ads_daily WHERE advert_id = ? AND date = ?').get(row.advert_id, today);
    spending = r.s > 0;
  }
  if (spending) return { status: 9, label: 'активна', apiStatus, byFact: true };
  return { status: 11, label: 'на паузе', apiStatus, byFact: false };
}
