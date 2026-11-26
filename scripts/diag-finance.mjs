// Проверка финотчёта в базе: из каких строк складываются комиссия и логистика.
// Только читает базу, ничего не меняет и в WB не ходит. Токенов и личных данных не выводит.
// Запуск: npm run diag
import { config } from '../src/config.mjs';
import { openDb } from '../src/db.mjs';
import { addDays, todayMsk } from '../src/dates.mjs';

const db = openDb(config.dataDir);
const from = addDays(todayMsk(), Number(process.argv[2]) || -90);
const r = (v, d = 0) => (v == null ? '—' : Number(v).toFixed(d));
const show = (title, rows) => {
  console.log(`\n== ${title}`);
  if (!rows.length) return console.log('(пусто)');
  const keys = Object.keys(rows[0]);
  console.log(keys.join(' | '));
  for (const row of rows) console.log(keys.map((k) => (typeof row[k] === 'number' ? r(row[k], Number.isInteger(row[k]) ? 0 : 2) : row[k] ?? '')).join(' | '));
};

console.log(`Финотчёт с ${from}. Строк всего: ${db.prepare('SELECT COUNT(*) n FROM finance_lines').get().n}, с ${from}: ${db.prepare('SELECT COUNT(*) n FROM finance_lines WHERE date >= ?').get(from).n}`);

show('По видам операций', db.prepare(`SELECT oper_name, COALESCE(bonus_type,'') bonus, COUNT(*) lines, SUM(quantity) qty,
    SUM(retail_price_disc) retail, SUM(for_pay) for_pay, SUM(delivery) delivery, SUM(delivery_amount) deliv_n, SUM(return_amount) ret_n,
    SUM(deduction) deduction, SUM(storage) storage, SUM(acceptance) acceptance, SUM(penalty) penalty, SUM(acquiring) acquiring, SUM(rebill) rebill
  FROM finance_lines WHERE date >= ? GROUP BY oper_name, bonus ORDER BY lines DESC LIMIT 40`).all(from));

show('Логистика по неделям', db.prepare(`SELECT strftime('%Y-%W', date) week, MIN(date) first, COUNT(*) lines, SUM(delivery) delivery,
    SUM(delivery_amount) deliv_n, SUM(return_amount) ret_n, SUM(deduction) deduction,
    SUM(CASE WHEN oper_name LIKE 'Продажа%' THEN quantity END) sold
  FROM finance_lines WHERE date >= ? GROUP BY week ORDER BY week`).all(from));

show('20 самых дорогих строк логистики', db.prepare(`SELECT date, nm_id, oper_name, COALESCE(bonus_type,'') bonus, delivery, delivery_amount deliv_n, return_amount ret_n, office_name
  FROM finance_lines WHERE date >= ? AND delivery > 0 ORDER BY delivery DESC LIMIT 20`).all(from));

show('Продажи: цена, к перечислению, комиссия WB (10 примеров)', db.prepare(`SELECT date, nm_id, quantity qty, retail_price_disc retail, for_pay, commission_pct kvv, acquiring
  FROM finance_lines WHERE date >= ? AND oper_name LIKE 'Продажа%' ORDER BY date DESC LIMIT 10`).all(from));

show('Продажи по товарам', db.prepare(`SELECT nm_id, COALESCE(vendor_code,'') vendor, COUNT(*) lines, SUM(quantity) qty, SUM(retail_price_disc) retail, SUM(for_pay) for_pay,
    ROUND(100 * (1 - SUM(for_pay) / NULLIF(SUM(retail_price_disc),0)), 1) kept_pct, ROUND(AVG(commission_pct),1) kvv_avg
  FROM finance_lines WHERE date >= ? AND oper_name LIKE 'Продажа%' GROUP BY nm_id ORDER BY qty DESC LIMIT 30`).all(from));

const { actualCosts } = await import('../src/metrics.mjs');
const shop = actualCosts(db, null, todayMsk(), 90, 1);
console.log('\n== Итог расчёта «Воронки» по магазину за 90 дней');
console.log(shop ? `продаж ${shop.soldUnits}; комиссия WB фактически ${r(shop.commissionPct, 1)}%; логистика на продажу ${r(shop.logisticsPerSold, 1)} ₽ (за доставку ${r(shop.logisticsPerDelivery, 1)} ₽); хранение+приёмка на продажу ${r(shop.storagePerSold + shop.acceptancePerSold, 1)} ₽; выкуп ${r(shop.buyoutPct, 0)}%; вывоз товара вам (не входит) ${r(shop.toSellerSum)} ₽` : 'мало данных');

db.close();
