// Автотесты расчётов, разбора ответов WB и входа. Запуск: npm test (сеть и токен не нужны).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from '../src/config.mjs';
import { hashPassword, verifyPassword, createSession, checkSession } from '../src/auth.mjs';
import { DEFAULT_SETTINGS } from '../src/db.mjs';
import { unitEconomics } from '../src/metrics.mjs';
import { simulate, STRATEGIES, normalizeParams } from '../src/strategies.mjs';
import { parseFunnelHistory, parseFullstats, parseAdverts, parsePrices, parseFinanceLines, parseFeedbacks, parseSearchTexts, parseFunnelProducts } from '../src/wb/collect.mjs';
import { createWbClient } from '../src/wb/client.mjs';
import { addDays, dateRange } from '../src/dates.mjs';

test('разбор .env', () => {
  const env = parseEnv('# коммент\nA=1\nB="два"\n  C = x=y \nбез_равно\n');
  assert.deepEqual(env, { A: '1', B: 'два', C: 'x=y' });
});

test('пароль и сессия', () => {
  const h = hashPassword('очень-длинный-пароль');
  assert.ok(verifyPassword('очень-длинный-пароль', h));
  assert.ok(!verifyPassword('другой', h));
  assert.ok(!verifyPassword('x', 'мусор'));
  const secret = 's'.repeat(40);
  const token = createSession(secret, 1000);
  assert.ok(checkSession(token, secret, 2000));
  assert.ok(!checkSession(token, secret, 1000 + 13 * 3600_000), 'сессия истекает через 12 часов');
  assert.ok(!checkSession(token, 'другой-секрет'.repeat(4), 2000));
  assert.ok(!checkSession(token.replace(/.$/, 'A'), secret, 2000) || token.endsWith('A'));
});

test('даты', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.deepEqual(dateRange('2026-11-29', '2026-12-01'), ['2026-11-29', '2026-11-30', '2026-12-01']);
});

test('юнит-экономика совпадает с калькулятором (цена 590, себестоимость 195)', () => {
  const u = unitEconomics({ price: 590, cost: 195, settings: { ...DEFAULT_SETTINGS } });
  // Как в таблице-калькуляторе: прибыль ~192,5 ₽, безубыточность ~333 ₽
  assert.equal(u.profitPerUnit, 193);
  assert.equal(u.breakEvenPrice, 333);
  assert.equal(u.workAdPerSale, 113);
  const noCost = unitEconomics({ price: 590, cost: null, settings: DEFAULT_SETTINGS });
  assert.equal(noCost.profitPerUnit, null);
});

test('юнит-экономика по фактам финотчёта', () => {
  const u = unitEconomics({ price: 1000, cost: 300, settings: DEFAULT_SETTINGS, actual: { commissionPct: 20, logisticsPerSold: 80, storagePerSold: 10 } });
  // 1000 × (1 − 0,20 − 0,02 − 0,06) − (300 + 80 + 10) = 720 − 390 = 330
  assert.equal(u.profitPerUnit, 330);
  assert.equal(u.source, 'finance');
});

test('разбор воронки по дням (формат API v3)', () => {
  const resp = [
    {
      product: { nmId: 1, title: 'Чай', vendorCode: 'A', brandName: '', subjectId: 406, subjectName: 'Чай' },
      history: [{ date: '2026-11-20', openCount: 100, cartCount: 12, orderCount: 6, orderSum: 5000, buyoutCount: 5, buyoutSum: 4200, buyoutPercent: 90, addToCartConversion: 12, cartToOrderConversion: 50, addToWishlistCount: 3 }],
      currency: 'RUB',
    },
  ];
  const { rows, products } = parseFunnelHistory(resp);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { nmId: 1, date: '2026-11-20', open: 100, cart: 12, orders: 6, orderSum: 5000, buyouts: 5, buyoutSum: 4200, buyoutPercent: 90, wishlist: 3 });
  assert.equal(products[0].vendorCode, 'A');
  assert.deepEqual(parseFunnelHistory(null).rows, []);
});

test('разбор сводки по товарам: остатки и рейтинг', () => {
  const r = parseFunnelProducts({ data: { products: [{ product: { nmId: 5, productRating: 4.8, feedbackRating: 4.9, stocks: { wb: 12, mp: 0 } }, statistic: { selected: { timeToReady: { days: 1, hours: 6, mins: 30 } } } }] } });
  assert.equal(r[0].stocksWb, 12);
  assert.equal(r[0].deliveryHours, 30.5);
});

test('разбор рекламы: только наши артикулы, суммирование по платформам', () => {
  const adverts = parseAdverts({ adverts: [{ id: 7, status: 9, settings: { name: 'к1', paymentType: 'cpc' }, nms: [{ nmId: 1 }, { nmId: 99 }] }, { id: 8, status: 9, settings: {}, nms: [{ nmId: 99 }] }] }, [1, 2]);
  assert.deepEqual(adverts.map((a) => [a.advertId, a.nmIds]), [[7, [1]]]);
  const rows = parseFullstats(
    [
      {
        advertId: 7,
        days: [
          {
            date: '2026-11-20T00:00:00Z',
            apps: [
              { appType: 1, nms: [{ nmId: 1, views: 100, clicks: 4, atbs: 1, orders: 1, shks: 1, sum: 30, sum_price: 800 }, { nmId: 99, views: 5, clicks: 1, sum: 1 }] },
              { appType: 32, nms: [{ nmId: 1, views: 200, clicks: 6, atbs: 0, orders: 0, shks: 0, sum: 45.5, sum_price: 0 }] },
            ],
          },
        ],
      },
    ],
    [1],
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { nmId: 1, date: '2026-11-20', advertId: 7, views: 300, clicks: 10, atbs: 1, orders: 1, shks: 1, spend: 75.5, orderSum: 800 });
});

test('разбор цен, отзывов, финотчёта, поиска', () => {
  const prices = parsePrices({ data: { listGoods: [{ nmID: 1, vendorCode: 'A', discount: 30, sizes: [{ price: 1000, discountedPrice: 700, clubDiscountedPrice: 680 }] }] } });
  assert.deepEqual(prices[0], { nmId: 1, vendorCode: 'A', price: 1000, sellerPrice: 700, clubPrice: 680, discountPct: 30 });

  const fb = parseFeedbacks({ data: { feedbacks: [{ id: 'x', productValuation: 2, text: 'плохо', productDetails: { nmId: 1 } }, { id: 'y', productDetails: { nmId: 5 } }] } }, [1], false);
  assert.equal(fb.length, 1);
  assert.equal(fb[0].answered, 0);

  const fin = parseFinanceLines([{ rrdId: 10, nmId: 1, rrDate: '2026-11-20', sellerOperName: 'Продажа', quantity: 2, retailPriceWithDisc: '1400', forPay: '1100.5', commissionPercent: 17, deliveryService: '0', paidStorage: '3', paidAcceptance: '0', penalty: '0', deduction: '0', acquiringFee: '28' }], [1]);
  assert.equal(fin[0].forPay, 1100.5);
  assert.equal(fin[0].storage, 3);

  const s = parseSearchTexts({ data: { items: [{ text: 'ча гао', frequency: { current: 300 }, avgPosition: { current: 10 }, visibility: { current: 40 }, openCard: { current: 5 }, orders: { current: 1 } }, { text: 'пуэр', frequency: { current: 100 }, avgPosition: { current: 50 }, visibility: { current: 0 }, openCard: { current: 1 }, orders: { current: 0 } }] } });
  assert.equal(s.avgPosition, 20); // (300×10 + 100×50) / 400
  assert.equal(s.openCard, 6);
});

const baseline = { nmId: 1, enoughData: true, organicOpensPerDay: 50, adClicksPerDay: 0, adSpendPerDay: 0, cartConv: 0.12, orderConv: 0.5, buyoutPct: 0.95, price: 590, cost: 195, actual: null };

test('симулятор: без стратегии сценарии совпадают, со стратегией заказы растут', () => {
  const r = simulate({ baseline, settings: DEFAULT_SETTINGS, strategyKey: 'ads_cpc', params: { dailyBudget: 400, cpc: 8 }, days: 30, startDate: '2026-12-01' });
  // как сейчас: 50 × 0,12 × 0,5 = 3 заказа в день → 90 за 30 дней
  assert.equal(r.base.totals.orders, 90);
  assert.ok(r.scenario.totals.orders > r.base.totals.orders);
  assert.equal(r.scenario.totals.spend, 12000);
  assert.equal(r.scenario.daily[0].date, '2026-12-01');
  assert.equal(r.scenario.daily.length, 30);
});

test('симулятор: скидка снижает цену и прибыль с продажи', () => {
  const r = simulate({ baseline, settings: DEFAULT_SETTINGS, strategyKey: 'discount', params: { discountPct: 20 }, days: 30 });
  assert.equal(r.scenario.totals.price, 472);
  assert.ok(r.scenario.totals.profitPerUnit < r.base.totals.profitPerUnit);
});

test('симулятор: без себестоимости прибыль не считается и есть предупреждение', () => {
  const r = simulate({ baseline: { ...baseline, cost: null }, settings: DEFAULT_SETTINGS, strategyKey: 'seo', params: {}, days: 30 });
  assert.equal(r.scenario.totals.profit, null);
  assert.ok(r.warnings.some((w) => w.includes('себестоимость')));
});

test('параметры стратегий ограничены пределами', () => {
  for (const s of STRATEGIES) {
    const p = normalizeParams(s, Object.fromEntries(s.params.map((x) => [x.key, 1e9])));
    for (const def of s.params) assert.equal(p[def.key], def.max, `${s.key}.${def.key}`);
    const r = simulate({ baseline, settings: DEFAULT_SETTINGS, strategyKey: s.key, params: {}, days: 30 });
    assert.ok(Number.isFinite(r.scenario.totals.orders), s.key);
  }
});

test('клиент WB: повтор при 429 и понятная ошибка при 403', async () => {
  const calls = [];
  const responses = [new Response('', { status: 429, headers: { 'X-Ratelimit-Retry': '1' } }), new Response('{"ok":1}', { status: 200 }), new Response('нет доступа', { status: 403 })];
  const client = createWbClient({ token: 't', fetchImpl: async (url, init) => (calls.push([String(url), init.headers.Authorization]), responses.shift()), wait: async () => {}, intervals: {} });
  assert.deepEqual(await client.get('analytics', '/x', { a: 1 }), { ok: 1 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1], 't');
  assert.ok(calls[0][0].endsWith('/x?a=1'));
  await assert.rejects(() => client.get('analytics', '/y'), /Джем|доступа/);
});
