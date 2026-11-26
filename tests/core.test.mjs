// Автотесты расчётов, разбора ответов WB и входа. Запуск: npm test (сеть и токен не нужны).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from '../src/config.mjs';
import { createSession, checkSession } from '../src/auth.mjs';
import { createManagementVerifier, pgEnvFromUrl, isTokenShape } from '../src/management-auth.mjs';
import { DEFAULT_SETTINGS } from '../src/db.mjs';
import { unitEconomics } from '../src/metrics.mjs';
import { simulate, STRATEGIES, normalizeParams } from '../src/strategies.mjs';
import { parseFunnelHistory, parseFullstats, parseAdverts, parsePrices, parseFinanceLines, parseFeedbacks, parseSearchTexts, parseFunnelProducts } from '../src/wb/collect.mjs';
import { createWbClient } from '../src/wb/client.mjs';
import { addDays, dateRange } from '../src/dates.mjs';
import { parseCostSheet, applyCosts, toCost } from '../src/costs.mjs';
import { openDb, ensureProducts } from '../src/db.mjs';

test('разбор .env', () => {
  const env = parseEnv('# коммент\nA=1\nB="два"\n  C = x=y \nбез_равно\n');
  assert.deepEqual(env, { A: '1', B: 'два', C: 'x=y' });
});

test('сессия', () => {
  const secret = 's'.repeat(40);
  const token = createSession(secret, 1000);
  assert.ok(checkSession(token, secret, 2000));
  assert.ok(!checkSession(token, secret, 1000 + 13 * 3600_000), 'сессия истекает через 12 часов');
  assert.ok(!checkSession(token, 'другой-секрет'.repeat(4), 2000));
  assert.ok(!checkSession(token.replace(/.$/, 'A'), secret, 2000) || token.endsWith('A'));
  // сессия не живёт дольше токена «Менеджмента»
  const short = createSession(secret, 1000, 1000 + 60 * 60_000);
  assert.ok(checkSession(short, secret, 1000 + 59 * 60_000));
  assert.ok(!checkSession(short, secret, 1000 + 61 * 60_000));
});

test('вход из «Менеджмента»: проверка токена по базе через psql', async () => {
  const env = pgEnvFromUrl('postgresql://tea_user:p%40ss@localhost:5433/tea_market?schema=public');
  assert.deepEqual([env.PGHOST, env.PGPORT, env.PGUSER, env.PGPASSWORD, env.PGDATABASE], ['localhost', '5433', 'tea_user', 'p@ss', 'tea_market']);
  assert.ok(isTokenShape('Ab_-'.repeat(11)));
  assert.ok(!isTokenShape("x'; drop table--"));
  const calls = [];
  const future = Date.now() + 30 * 60_000;
  const execImpl = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    const sql = args.at(-1);
    cb(null, sql.includes(require_hash) ? `${future}\n` : '', '');
  };
  const crypto = await import('node:crypto');
  const good = 'A'.repeat(43);
  const require_hash = crypto.createHash('sha256').update(good).digest('hex');
  const verify = createManagementVerifier({ databaseUrl: 'postgresql://u:secret@localhost/db', execImpl });
  assert.equal(await verify(good), future);
  assert.equal(await verify('B'.repeat(43)), null);
  assert.equal(await verify("bad token'"), null);
  assert.equal(calls.length, 2, 'кривой токен до базы не доходит');
  assert.equal(calls[0].cmd, 'psql');
  assert.ok(!calls[0].args.join(' ').includes('secret'), 'пароль базы не в командной строке');
  assert.equal(calls[0].opts.env.PGPASSWORD, 'secret');
  const failing = createManagementVerifier({ databaseUrl: 'postgresql://u:p@h/db', execImpl: (c, a, o, cb) => cb(new Error('boom'), '', 'connection refused') });
  await assert.rejects(() => failing(good), /Не удалось проверить доступ/);
});

test('даты', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.deepEqual(dateRange('2026-11-29', '2026-12-01'), ['2026-11-29', '2026-11-30', '2026-12-01']);
});

test('юнит-экономика только по реальным данным: тарифы, объём, выкуп; чего нет — в списке', () => {
  // Тариф короба: 46 ₽ первый литр + 14 ₽ за доп. литр; пакет 0,864 л → 46 ₽ за доставку; выкуп 90% → 51,1 ₽ на проданную штуку
  const inputs = {
    commission: { pct: 29.5, source: 'тариф' },
    logistics: { perDelivery: 46, source: 'тариф WB' },
    storage: { perDay: 0.08, days: 100, source: 'тариф WB' },
    buyoutPct: 90,
  };
  const u = unitEconomics({ price: 1264, cost: 189, settings: { ...DEFAULT_SETTINGS, taxPct: 6 }, inputs });
  // 1264 × (1 − 0,295 − 0,06) − (189 + 51,1 + 8) = 815,3 − 248,1 = 567
  assert.equal(u.profitPerUnit, 567);
  assert.deepEqual(u.missing, ['эквайринг (появится из финотчёта WB после первых продаж)', 'обратная логистика невыкупов (тарифа нет в API WB — появится из финотчёта)']);
  assert.equal(u.complete, false);
  // Налог не задан — так и пишем, не подставляем 6%
  const noTax = unitEconomics({ price: 1264, cost: 189, settings: DEFAULT_SETTINGS, inputs });
  assert.ok(noTax.missing.some((m) => m.startsWith('налог')));
  // Нет себестоимости или комиссии — прибыль не считается
  assert.equal(unitEconomics({ price: 590, cost: null, settings: DEFAULT_SETTINGS, inputs }).profitPerUnit, null);
  assert.equal(unitEconomics({ price: 590, cost: 195, settings: DEFAULT_SETTINGS, inputs: { ...inputs, commission: null } }).profitPerUnit, null);
});

test('юнит-экономика по фактам финотчёта', () => {
  const u = unitEconomics({
    price: 1000, cost: 300, settings: { ...DEFAULT_SETTINGS, taxPct: 6 },
    inputs: { commission: { pct: 20, source: 'финотчёт' }, acquiring: { pct: 2, source: 'финотчёт' }, fact: { logisticsPerSold: 80, storagePerSold: 10 }, buyoutPct: 95 },
  });
  // 1000 × (1 − 0,20 − 0,02 − 0,06) − (300 + 80 + 10) = 720 − 390 = 330
  assert.equal(u.profitPerUnit, 330);
  assert.equal(u.source, 'finance');
  assert.equal(u.complete, true);
});

test('тариф короба по формуле WB: первый литр + доп. литры', async () => {
  const { boxTariff } = await import('../src/metrics.mjs');
  assert.equal(boxTariff(46, 14, 0.864), 46);
  assert.equal(boxTariff(46, 14, 3), 74);
  assert.equal(boxTariff(46, 14, null), null);
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

test('разбор рекламы: все кампании, ставки из копеек в рубли, суммирование по платформам', () => {
  const adverts = parseAdverts({ adverts: [
    { id: 7, status: 9, settings: { name: 'к1', paymentType: 'cpc' }, nms: [{ nmId: 1, subject: { id: 406, name: 'Чай' }, bids: { search: 900 } }, { nmId: 99 }] },
    { advertId: 8, status: 4, settings: {}, nms: [{ nmId: 99 }] },
    { status: 9, nms: [{ nmId: 5 }] },
  ] });
  assert.deepEqual(adverts.map((a) => [a.advertId, a.status, a.nmIds]), [[7, 9, [1, 99]], [8, 4, [99]]]);
  assert.equal(adverts[0].bids[1].search, 9);
  assert.deepEqual(adverts[0].subjects, [{ nmId: 1, id: 406, name: 'Чай' }]);
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

const baseline = {
  nmId: 1, enoughData: true, organicOpensPerDay: 50, adClicksPerDay: 0, adSpendPerDay: 0, cartConv: 0.12, orderConv: 0.5, buyoutPct: 0.95, price: 590, cost: 195, actual: null,
  costInputs: { commission: { pct: 25, source: 'тариф' }, logistics: { perDelivery: 46, source: 'тариф' }, storage: { perDay: 0.08, days: 60, source: 'тариф' }, buyoutPct: 95 },
};

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

test('себестоимость из листа «Себестоимость»: разбор и привязка по артикулу продавца', () => {
  assert.equal(toCost('165,35'), 165.35);
  assert.equal(toCost(144.5), 144.5);
  assert.equal(toCost('146,00%'), null);
  assert.equal(toCost('.'), null);
  const map = parseCostSheet([
    ['Артикул', 'Наименование', 'Себестоимость'],
    ['SMOLA-SMILE-10,5', 'Смайлики 15', 202.5],
    ['SMOLA-GABA-2', 'Габа 2', '68'],
    ['SMOLA-GABA-6', 'Габа 6', '.'],
  ]);
  assert.equal(map.get('SMOLA-SMILE-10,5').cost, 202.5);
  const db = openDb('', { memory: true });
  ensureProducts(db, [1, 2, 3, 4]);
  const set = db.prepare('UPDATE products SET vendor_code = ? WHERE nm_id = ?');
  set.run('smola-smile-10,5', 1); // регистр не важен
  set.run('SMOLA-GABA-2', 2);
  set.run('SMOLA-GABA-6', 3);
  set.run('NO-SUCH', 4);
  const r = applyCosts(db, map);
  assert.equal(r.matched, 2);
  assert.deepEqual(r.missing, ['NO-SUCH']);
  assert.equal(r.invalid.length, 1);
  const row = db.prepare('SELECT cost_per_unit, cost_source FROM products WHERE nm_id = 1').get();
  assert.equal(row.cost_per_unit, 202.5);
  assert.equal(row.cost_source, 'sheet');
  assert.throws(() => parseCostSheet([['Код', 'Цена']]), /Артикул/);
});

test('чтение Google Таблицы роботом: подпись JWT и запрос значений', async () => {
  const { generateKeyPairSync, createVerify } = await import('node:crypto');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createSheetsReader, sheetRange } = await import('../src/google-sheets.mjs');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyFile = path.join(os.tmpdir(), `wb-test-key-${process.pid}.json`);
  fs.writeFileSync(keyFile, JSON.stringify({ client_email: 'robot@test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(String(url));
    if (String(url).includes('oauth2')) {
      const assertion = new URLSearchParams(init.body.toString()).get('assertion');
      const [h, p, sig] = assertion.split('.');
      assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url')), 'подпись верна');
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/spreadsheets.readonly');
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    }
    assert.equal(init.headers.Authorization, 'Bearer tok');
    return new Response(JSON.stringify({ values: [['Артикул', 'Себестоимость'], ['A', 10]] }));
  };
  try {
    const reader = createSheetsReader({ keyFile, spreadsheetId: 'SHEET', fetchImpl });
    const values = await reader.getValues(sheetRange('Себестоимость', 'A1:Z'));
    assert.deepEqual(values[1], ['A', 10]);
    assert.ok(calls[1].includes(encodeURIComponent("'Себестоимость'!A1:Z")));
    await reader.getValues('x');
    assert.equal(calls.filter((c) => c.includes('oauth2')).length, 1, 'токен Google кэшируется');
  } finally {
    fs.unlinkSync(keyFile);
  }
});

test('список товаров: колонка «Воронка WB», запасные варианты', async () => {
  const { parseTrackedNmIds } = await import('../src/costs.mjs');
  const { resolveTrackedNmIds, savedTrackedNmIds } = await import('../src/sync.mjs');
  const { openDb } = await import('../src/db.mjs');
  assert.deepEqual(parseTrackedNmIds([['Артикул', 'Себестоимость']]), { hasColumn: false, nmIds: [] });
  assert.deepEqual(
    parseTrackedNmIds([['Артикул', 'Себестоимость', 'Воронка WB'], ['A', 1, 1293530574], ['B', 2, ''], ['C', 3, '1293550875'], ['D', 4, 1293530574]]),
    { hasColumn: true, nmIds: [1293530574, 1293550875] },
  );
  const quiet = { warn() {} };
  const db = openDb('', { memory: true });
  // колонки нет — список из .env
  assert.deepEqual(await resolveTrackedNmIds(db, { costsSource: { readTracked: async () => ({ hasColumn: false, nmIds: [] }) }, fallback: [1], log: quiet }), { nmIds: [1], source: 'env' });
  // колонка есть — из таблицы, и список запоминается
  assert.deepEqual(await resolveTrackedNmIds(db, { costsSource: { readTracked: async () => ({ hasColumn: true, nmIds: [7, 8] }) }, fallback: [1], log: quiet }), { nmIds: [7, 8], source: 'sheet' });
  assert.deepEqual(savedTrackedNmIds(db, [1]), [7, 8]);
  // таблица недоступна — последний известный список
  const r = await resolveTrackedNmIds(db, { costsSource: { readTracked: async () => { throw new Error('нет связи'); } }, fallback: [1], log: quiet });
  assert.deepEqual([r.nmIds, r.source], [[7, 8], 'saved']);
  db.close();
});

test('факт из финотчёта: фактическая комиссия, медиана логистики, выброс не учитывается, медианы магазина', async () => {
  const { openDb } = await import('../src/db.mjs');
  const { actualCosts } = await import('../src/metrics.mjs');
  const db = openDb('', { memory: true });
  const ins = db.prepare(`INSERT INTO finance_lines(rrd_id, nm_id, date, oper_name, quantity, retail_price_disc, for_pay, commission_pct, delivery, delivery_amount, return_amount, storage, acceptance, penalty, deduction, acquiring)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let id = 1;
  for (let i = 0; i < 4; i++) ins.run(id++, 1, '2026-11-20', 'Продажа', 1, 1000, 860, 25, 0, 0, 0, 0, 0, 0, 0, 20);
  for (let i = 0; i < 4; i++) ins.run(id++, 1, '2026-11-20', 'Логистика', 0, 0, 0, 0, 60, 1, 0, 0, 0, 0, 0, 0);
  ins.run(id++, 1, '2026-11-20', 'Логистика', 0, 0, 0, 0, 50, 0, 1, 0, 0, 0, 0, 0); // обратная доставка
  ins.run(id++, 1, '2026-11-21', 'Логистика', 0, 0, 0, 0, 150000, 1, 0, 0, 0, 0, 0, 0); // ошибочное начисление WB
  ins.run(id++, 2, '2026-11-21', 'Продажа', 10, 5000, 4000, 25, 0, 0, 0, 0, 0, 0, 0, 0);
  const own = actualCosts(db, 1, '2026-11-26', 90, 3);
  assert.equal(Math.round(own.commissionPct), 14); // 1 − 3440 / 4000
  assert.equal(own.logisticsPerSold, (240 + 50) / 4);
  assert.equal(own.logisticsPerDelivery, 60);
  assert.equal(own.outliers, 1);
  assert.equal(actualCosts(db, 3, '2026-11-26', 90, 3), null); // у товара нет продаж
  const shop = actualCosts(db, null, '2026-11-26', 90, 10);
  assert.equal(shop.soldUnits, 14);
  db.close();
});

test('финотчёт: доставка «к продавцу» (вывоз товара) не входит в логистику продажи', async () => {
  const { openDb } = await import('../src/db.mjs');
  const { actualCosts } = await import('../src/metrics.mjs');
  const db = openDb('', { memory: true });
  const ins = db.prepare(`INSERT INTO finance_lines(rrd_id, nm_id, date, oper_name, bonus_type, quantity, retail_price_disc, for_pay, delivery, delivery_amount, return_amount)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  let id = 1;
  for (let i = 0; i < 10; i++) {
    ins.run(id++, 5, '2026-11-20', 'Продажа', '', 1, 120, 81, 0, 0, 0);
    ins.run(id++, 5, '2026-11-20', 'Доставка', 'К клиенту при продаже', 0, 0, 0, 70, 1, 0);
  }
  for (let i = 0; i < 50; i++) ins.run(id++, 6, '2026-11-01', 'Доставка', 'Возврат неопознанного товара (К продавцу)', 0, 0, 0, 255, 1, 0);
  const shop = actualCosts(db, null, '2026-11-26', 90, 10);
  assert.equal(shop.logisticsPerSold, 70);
  assert.equal(shop.logisticsPerDelivery, 70);
  assert.equal(shop.buyoutPct, 100);
  assert.equal(shop.toSellerSum, 255 * 50);
  assert.equal(Math.round(shop.commissionPct * 10) / 10, 32.5);
  db.close();
});

test('диапазон Уилсона и коридор ставок', async () => {
  const { wilson } = await import('../src/stats.mjs');
  const { adRange, budgetPlan } = await import('../src/ads.mjs');
  const w = wilson(8, 174);
  assert.ok(w.low > 0.02 && w.low < 0.03, `низ ${w.low}`);
  assert.ok(w.high > 0.07 && w.high < 0.08, `верх ${w.high}`);
  assert.ok(wilson(80, 1740).high - wilson(80, 1740).low < w.high - w.low); // больше данных — уже диапазон
  const inputs = { paymentType: 'cpc', bid: 9, chargeRatio: 0.65, cr: 8 / 174, crLow: w.low, crHigh: w.high, price: 1264, profitPerUnit: 497, buyoutPct: 90, buyoutLow: 85, buyoutHigh: 94, targetDrrPct: 20, dailyBudget: 337 };
  const r = adRange(inputs);
  assert.ok(r.pess.breakEvenBid < r.base.breakEvenBid && r.base.breakEvenBid < r.opt.breakEvenBid);
  assert.ok(r.pess.profitPerOrderAfterAds < r.base.profitPerOrderAfterAds);
  const plan = budgetPlan(inputs, r, { clicks: 40 }, { stockUnits: 42 });
  assert.equal(plan.test.clicks, 60);
  assert.ok(plan.rows.find((x) => x.current).budget === 337);
});

test('выкуп из аналитики WB: свой при ≥10 завершённых заказах, иначе по магазину', async () => {
  const { openDb } = await import('../src/db.mjs');
  const { buyoutFor } = await import('../src/metrics.mjs');
  const db = openDb('', { memory: true });
  const ins = db.prepare('INSERT INTO buyout_stats(nm_id, date_from, date_to, orders, buyouts, cancels) VALUES (?,?,?,?,?,?)');
  ins.run(0, '2026-08-19', '2026-11-12', 500, 400, 90);
  ins.run(1, '2026-08-19', '2026-11-12', 40, 30, 8);
  ins.run(2, '2026-08-19', '2026-11-12', 3, 2, 1);
  const own = buyoutFor(db, 1);
  assert.equal(Math.round(own.pct), 79);
  assert.match(own.source, /^по товару/);
  const shop = buyoutFor(db, 2);
  assert.equal(Math.round(shop.pct), 82);
  assert.match(shop.source, /по всему магазину/);
  assert.ok(shop.low < shop.pct && shop.high > shop.pct);
  db.close();
});

test('конверсия подстраивается: свежие дни весомее, при малом числе кликов помогает конверсия карточки', async () => {
  const { decayedRate } = await import('../src/stats.mjs');
  // 2 недели назад конверсия была 10%, последние дни — 2%: оценка ближе к свежей
  const rows = [{ date: '2026-11-12', clicks: 100, orders: 10 }, { date: '2026-11-25', clicks: 100, orders: 2 }];
  const est = decayedRate(rows, '2026-11-26');
  assert.ok(est.rate < 0.045, `оценка ${est.rate}`);
  // 10 кликов без заказов, но карточка конвертирует 4%: оценка не ноль
  const small = decayedRate([{ date: '2026-11-25', clicks: 10, orders: 0 }], '2026-11-26', { prior: 0.04 });
  assert.ok(small.rate > 0.025 && small.rate < 0.04);
});
