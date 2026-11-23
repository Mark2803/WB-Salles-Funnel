// Сквозной тест: сервер в тестовом режиме, база в памяти, вход, сбор, сводка, планы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { createServer } from '../src/server.mjs';
import { runSync } from '../src/sync.mjs';
import { createMockClient, createMockCostsSource } from '../src/wb/mock.mjs';

const NM = [1293796729, 1293819178, 1293550875];
const cfg = { mock: true, wbToken: '', sessionSecret: 'x'.repeat(40), trackedNmIds: NM, basePath: '/management/wb-funnel', cookieSecure: false };
const quiet = { warn() {}, error() {}, log() {} };

test('API: вход, сбор, сводка, симулятор, планы, журнал', async () => {
  const db = openDb('', { memory: true });
  const run = await runSync(db, { kind: 'full', client: createMockClient({ nmIds: NM }), costsSource: createMockCostsSource(), nmIds: NM, log: quiet });
  assert.equal(run.status, 'ok', JSON.stringify(run.details.filter((d) => !d.ok)));
  const TOKEN = 'T'.repeat(43);
  const server = createServer({ db, cfg, log: quiet, verifyToken: async (t) => (t === TOKEN ? Date.now() + 3600_000 : null) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, path, body, { csrf = true } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-Requested-With': 'wb-funnel' } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* не JSON */
    }
    return { status: res.status, json, text };
  };
  try {
    assert.equal((await call('GET', '/api/overview')).status, 401);
    assert.equal((await call('POST', '/api/login', { token: 'неверно' })).status, 401);
    assert.equal((await call('POST', '/api/login', { token: TOKEN })).status, 200);
    assert.match(cookie, /^wb_funnel_session=/);

    const ov = await call('GET', '/api/overview');
    assert.equal(ov.status, 200);
    assert.equal(ov.json.products.length, 3);
    assert.ok(ov.json.products[0].week.open > 0);

    // без заголовка защиты изменяющий запрос отклоняется
    assert.equal((await call('PUT', '/api/products/1293819178', { cost_per_unit: 250 }, { csrf: false })).status, 403);
    // себестоимость из таблицы «Финансы V3» вручную не меняется
    assert.equal((await call('PUT', '/api/products/1293819178', { cost_per_unit: 250 })).status, 409);
    let prod = await call('GET', '/api/products/1293819178');
    assert.equal(prod.json.summary.unit.cost, 202.5);
    assert.equal(prod.json.summary.costSource, 'sheet');
    // товар, которого нет в таблице, — можно вручную
    db.prepare('UPDATE products SET cost_source = NULL, cost_per_unit = NULL WHERE nm_id = 1293550875').run();
    assert.equal((await call('PUT', '/api/products/1293550875', { cost_per_unit: -5 })).status, 400);
    assert.equal((await call('PUT', '/api/products/1293550875', { cost_per_unit: 140 })).status, 200);
    prod = await call('GET', '/api/products/1293550875');
    assert.equal(prod.json.summary.costSource, 'manual');
    assert.equal((await call('GET', '/api/products/123')).status, 404);
    assert.equal(prod.json.series.length, 30);

    const sim = await call('POST', '/api/simulate', { nmId: 1293819178, strategyKey: 'reviews', params: { reviews: 20 } });
    assert.equal(sim.status, 200);
    assert.ok(sim.json.scenario.totals.orders >= sim.json.base.totals.orders);

    const created = await call('POST', '/api/plans', { nmId: 1293819178, strategyKey: 'reviews', params: { reviews: 20 }, note: 'тест' });
    const id = created.json.id;
    assert.equal((await call('POST', `/api/plans/${id}/activate`, { startDate: '2026-11-20' })).status, 200);
    assert.equal((await call('DELETE', `/api/plans/${id}`)).status, 409, 'активный план не удаляется');
    const plans = await call('GET', '/api/plans');
    assert.equal(plans.json.plans[0].status, 'active');
    assert.ok(plans.json.plans[0].progress.days.length > 0);

    const j = await call('GET', '/api/journal');
    assert.ok(j.json.entries.some((e) => e.text.includes('Запущена стратегия')));
    assert.equal((await call('POST', '/api/journal', { text: '' })).status, 400);

    const md = await call('GET', '/api/export/claude');
    assert.match(md.text, /# Воронка WB/);
    assert.match(md.text, /Отзывы за баллы/);

    assert.equal((await call('PUT', '/api/settings', { targetDrrPct: 'abc' })).status, 400);
    assert.equal((await call('PUT', '/api/settings', { targetDrrPct: 25 })).json.settings.targetDrrPct, 25);

    // статические файлы и защита от выхода за пределы папки
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.ok(page.headers.get('content-security-policy'));
    const outside = await fetch(base + '/..%2F.env');
    assert.equal(outside.status, 404);
  } finally {
    server.close();
    db.close();
  }
});
