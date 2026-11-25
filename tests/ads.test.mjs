// Экономика рекламы: формулы, сценарии ставок, сравнение прогноза с фактом, советы, сбор с тестового WB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adEconomics, adRecommendations, bidScenarios, compareForecast, effectiveCpc, bidForCpc } from '../src/ads.mjs';

test('цена клика: за клик с аукционом второй цены и за показы', () => {
  assert.equal(effectiveCpc({ paymentType: 'cpc', bid: 9, chargeRatio: 0.46 }), 9 * 0.46);
  assert.equal(effectiveCpc({ paymentType: 'cpm', bid: 300, ctr: 0.03 }), 10);
  assert.equal(bidForCpc({ paymentType: 'cpc', chargeRatio: 0.5 }, 4), 8);
  assert.equal(bidForCpc({ paymentType: 'cpm', ctr: 0.03 }, 10), 300);
});

test('экономика клика: ДРР, стоимость заказа, безубыточная ставка и ставка под цель', () => {
  // цена 1280, прибыль с продажи 400, выкуп 90% → прибыль с заказа 360; конверсия 3%, клик 6 ₽
  const e = adEconomics({ paymentType: 'cpc', bid: 6, cr: 0.03, price: 1280, profitPerUnit: 400, buyoutPct: 90, targetDrrPct: 10, clicksPerDay: 50 });
  assert.equal(e.profitPerOrder, 360);
  assert.equal(e.costPerOrder, 200); // 6 / 0,03
  assert.equal(e.drrPct, 15.6); // 6 / (0,03 × 1280)
  assert.equal(e.profitPerOrderAfterAds, 160);
  assert.equal(e.breakEvenCpc, 10.8); // 360 × 0,03
  assert.equal(e.targetCpc, 3.84); // 10% × 1280 × 0,03
  assert.equal(e.breakEvenBid, 10.8);
  assert.deepEqual(e.perDay, { views: null, clicks: 50, orders: 1.5, buyouts: 1.35, spend: 300, revenue: 1920, profit: 240 });
});

test('без себестоимости прибыль не считается, ДРР считается', () => {
  const e = adEconomics({ paymentType: 'cpc', bid: 5, cr: 0.05, price: 1000, profitPerUnit: null, buyoutPct: 95, targetDrrPct: 20 });
  assert.equal(e.profitPerOrder, null);
  assert.equal(e.breakEvenCpc, null);
  assert.equal(e.drrPct, 10);
});

test('сценарии ставок: клики растут медленнее ставки и упираются в бюджет', () => {
  const rows = bidScenarios({ paymentType: 'cpc', bid: 10, cr: 0.03, price: 1000, profitPerUnit: 300, buyoutPct: 100, targetDrrPct: 15, clicksPerDay: 20, dailyBudget: 300 });
  const cur = rows.find((r) => r.current);
  assert.equal(cur.perDay.clicks, 20);
  const x2 = rows.find((r) => r.bid === 20);
  assert.equal(x2.perDay.clicks, 15); // хотели бы ~32, но бюджет 300 ₽ / 20 ₽ = 15
  assert.ok(x2.drrPct > cur.drrPct);
});

test('прогноз против факта и советы', () => {
  const forecast = adEconomics({ paymentType: 'cpc', bid: 6, cr: 0.03, price: 1280, profitPerUnit: 400, buyoutPct: 90, targetDrrPct: 10, clicksPerDay: 50 });
  const fact = { days: 7, views: 9000, clicks: 350, orders: 4, spend: 2100, orderSum: 5120, ctr: 3.9, cpc: 6, cr: 1.14, costPerOrder: 525, drrPct: 41, perDay: { clicks: 50, orders: 0.57, spend: 300 } };
  const cmp = compareForecast(forecast, fact);
  const drr = cmp.find((r) => r.key === 'drr');
  assert.equal(drr.plan, 15.6);
  assert.equal(drr.good, false);
  const recs = adRecommendations({
    econ: adEconomics({ paymentType: 'cpc', bid: 6, cr: fact.orders / fact.clicks, price: 1280, profitPerUnit: 400, buyoutPct: 90, targetDrrPct: 10 }),
    fact,
    inputs: { paymentType: 'cpc', bid: 6, status: 9, profitPerUnit: 400, crSource: 'рекламы' },
    recommended: null,
    organicCr: 0.04,
    stockDays: 30,
    settings: { targetDrrPct: 10, minStockDays: 14 },
  });
  assert.equal(recs[0].level, 'critical');
  assert.match(recs[0].text, /Реклама в минус/);
  assert.ok(recs.some((r) => /минус-фразы/.test(r.text)));
});

test('мало кликов — предупреждение, без выводов по ДРР', () => {
  const recs = adRecommendations({
    econ: adEconomics({ paymentType: 'cpc', bid: 9, cr: 0.03, price: 1280, profitPerUnit: 400, buyoutPct: 90, targetDrrPct: 10 }),
    fact: { days: 1, views: 81, clicks: 11, orders: 0, spend: 45.53, orderSum: 0, ctr: 13.58, cpc: 4.14, cr: 0, drrPct: null, perDay: { clicks: 11, orders: 0, spend: 46 } },
    inputs: { paymentType: 'cpc', bid: 9, status: 9, profitPerUnit: 400, crSource: 'карточки за 30 дней' },
    recommended: { competitive: 12 },
    organicCr: 0.03,
    stockDays: null,
    settings: { targetDrrPct: 10, minStockDays: 14 },
  });
  assert.match(recs[0].text, /Пока 11 кликов/);
  assert.ok(!recs.some((r) => r.level === 'critical'));
});

test('ставки WB в виде массива и заказы других товаров в кампании (как в отчёте WB 25.11.2026)', async () => {
  const { parseAdverts } = await import('../src/wb/collect.mjs');
  const { openDb } = await import('../src/db.mjs');
  const { adFact } = await import('../src/ads.mjs');
  const [a] = parseAdverts({ adverts: [{ advertId: 42174321, nms: [{ bids: [{ type: 'search', value: 900 }], nmId: 1293557865, subject: { id: 406, name: 'чай' } }], settings: { name: 'Кампания от 24.11.2026', paymentType: 'cpc', placements: ['search'] }, status: 11, timestamps: { created: '2026-11-24T08:51:23+03:00', started: null } }] });
  assert.deepEqual([a.advertId, a.status, a.bids[1293557865].search, a.placements], [42174321, 11, 9, { search: true, recommendations: false }]);

  const db = openDb('', { memory: true });
  const ins = db.prepare('INSERT INTO ads_daily(nm_id, date, advert_id, views, clicks, atbs, orders, shks, spend, order_sum) VALUES (?,?,?,?,?,?,?,?,?,?)');
  ins.run(1293557865, '2026-11-24', 42174321, 390, 74, 12, 3, 0, 360.36, 3792);
  ins.run(1293566093, '2026-11-24', 42174321, 0, 0, 2, 0, 0, 0, 0);
  ins.run(1293557865, '2026-11-25', 42174321, 172, 25, 2, 0, 0, 168.87, 0);
  ins.run(1293566093, '2026-11-25', 42174321, 0, 0, 1, 1, 0, 0, 1750);
  const f = adFact(db, 42174321, 1293557865, '2026-11-24', '2026-11-25', 1264, { withOthers: true });
  assert.deepEqual([f.views, f.clicks, f.orders, f.otherOrders, f.spend, f.orderSum, f.days], [562, 99, 4, 1, 529, 5542, 2]);
  assert.equal(f.drrWbPct, 9.5); // 529,23 / 5542 — как «Доля затрат» в отчёте WB
  const own = adFact(db, 42174321, 1293557865, '2026-11-24', '2026-11-25', 1264);
  assert.equal(own.orders, 3);
  db.close();
});
