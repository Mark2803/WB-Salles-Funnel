// JSON API инструмента. Все методы, кроме входа, требуют авторизации.
// Ошибки всегда в формате { error: { code, message } } с понятным текстом на русском.
import {
  COOKIE_NAME,
  checkSession,
  createSession,
  loginAllowed,
  parseCookies,
  registerFailedLogin,
  resetLogin,
  sessionCookie,
  SESSION_MAX_AGE_SEC,
} from './auth.mjs';
import { createManagementVerifier, createMockVerifier } from './management-auth.mjs';
import { getSettings, saveSettings, nowIso } from './db.mjs';
import { addDays, isDate, todayMsk } from './dates.mjs';
import { baselineFor, overview, productSeries, productSummary } from './metrics.mjs';
import { STRATEGIES, defaultParams, getStrategy, normalizeParams, planVsFact, simulate, strategyCatalog } from './strategies.mjs';
import { buildClaudeSummary } from './summary.mjs';
import { adsCalc, adsOverview } from './ads.mjs';
import { isSyncRunning, lastRuns, runSync } from './sync.mjs';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MAX_BODY = 100_000;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'TOO_LARGE', 'Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'BAD_JSON', 'Неверный формат данных'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

function clientIp(req) {
  return String(req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown');
}

function nmIdParam(value, db) {
  const nmId = Number(value);
  if (!Number.isInteger(nmId) || nmId <= 0) throw new HttpError(400, 'BAD_NM', 'Неверный артикул');
  const p = db.prepare('SELECT * FROM products WHERE nm_id = ?').get(nmId);
  if (!p) throw new HttpError(404, 'NOT_FOUND', 'Артикул не отслеживается');
  return p;
}

const text = (v, max = 2000) => String(v ?? '').trim().slice(0, max);

export function createApi({ db, cfg, log = console, verifyToken }) {
  const verify = verifyToken || (cfg.mock ? createMockVerifier() : createManagementVerifier({ databaseUrl: cfg.databaseUrl }));
  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, re, keys, handler, auth });
  };

  // ---------- Вход ----------
  route('GET', '/api/me', ({ authed }) => ({ authenticated: authed, mock: cfg.mock }), { auth: false });

  route(
    'POST',
    '/api/login',
    async ({ req, body, res }) => {
      const ip = clientIp(req);
      if (!loginAllowed(ip)) throw new HttpError(429, 'TOO_MANY', 'Слишком много попыток. Подождите 10 минут.');
      let exp = null;
      try {
        exp = await verify(body.token);
      } catch (err) {
        log.error?.(`[auth] ${err.message}`);
        throw new HttpError(503, 'AUTH_UNAVAILABLE', 'Не удалось проверить доступ. Попробуйте ещё раз через минуту.');
      }
      if (!exp) {
        registerFailedLogin(ip);
        throw new HttpError(401, 'MANAGEMENT_LOCKED', 'Доступ закрыт. Откройте инструмент заново через админку → «Менеджмент» (ввод PIN).');
      }
      resetLogin(ip);
      const maxAgeSec = Math.max(60, Math.min(SESSION_MAX_AGE_SEC, Math.floor((exp - Date.now()) / 1000)));
      res.setHeader('Set-Cookie', sessionCookie(createSession(cfg.sessionSecret, Date.now(), exp), { secure: cfg.cookieSecure, path: cfg.basePath, maxAgeSec }));
      return { ok: true, expiresAt: new Date(exp).toISOString() };
    },
    { auth: false },
  );

  route('POST', '/api/logout', ({ res }) => {
    res.setHeader('Set-Cookie', sessionCookie('', { secure: cfg.cookieSecure, path: cfg.basePath, maxAgeSec: 0 }));
    return { ok: true };
  });

  // ---------- Сводка ----------
  route('GET', '/api/overview', () => {
    const settings = getSettings(db);
    const today = todayMsk();
    const runs = lastRuns(db, 1);
    return { today, products: overview(db, settings, today), lastSync: runs[0] || null, syncRunning: isSyncRunning(), mock: cfg.mock, settings };
  });

  // ---------- Товар ----------
  route('GET', '/api/products/:nm', ({ params, url }) => {
    const p = nmIdParam(params.nm, db);
    const settings = getSettings(db);
    const today = todayMsk();
    const days = Math.min(90, Math.max(7, Number(url.searchParams.get('days')) || 30));
    const search = db.prepare('SELECT date, avg_position, visibility, queries_json FROM search_daily WHERE nm_id = ? ORDER BY date DESC LIMIT 1').get(p.nm_id);
    return {
      summary: productSummary(db, p, settings, today),
      series: productSeries(db, p.nm_id, days, today),
      feedbacks: db.prepare('SELECT id, created_at, rating, text, pros, cons, answered, answer_text FROM feedbacks WHERE nm_id = ? ORDER BY created_at DESC LIMIT 20').all(p.nm_id),
      search: search ? { date: search.date, avgPosition: search.avg_position, visibility: search.visibility, queries: JSON.parse(search.queries_json || '[]') } : null,
      journal: db.prepare('SELECT * FROM journal WHERE nm_id = ? OR nm_id IS NULL ORDER BY date DESC, id DESC LIMIT 50').all(p.nm_id),
      plans: db.prepare('SELECT id, strategy_key, title, status, start_date, created_at FROM plans WHERE nm_id = ? ORDER BY id DESC').all(p.nm_id),
      campaigns: db.prepare('SELECT advert_id, name, status, payment_type, nm_ids FROM campaigns').all().filter((c) => JSON.parse(c.nm_ids || '[]').includes(p.nm_id)),
    };
  });

  route('PUT', '/api/products/:nm', ({ params, body }) => {
    const p = nmIdParam(params.nm, db);
    if (p.cost_source === 'sheet' && body.cost_per_unit !== undefined && Number(body.cost_per_unit) !== p.cost_per_unit) {
      throw new HttpError(409, 'COST_FROM_SHEET', 'Себестоимость этого товара берётся из таблицы «Финансы V3» — измените её в Менеджменте → «Себестоимость».');
    }
    const cost = body.cost_per_unit === '' || body.cost_per_unit == null ? null : Number(body.cost_per_unit);
    if (cost != null && (!Number.isFinite(cost) || cost < 0)) throw new HttpError(400, 'BAD_COST', 'Себестоимость должна быть числом не меньше 0');
    if (p.cost_source === 'sheet') db.prepare('UPDATE products SET group_name = ?, updated_at = ? WHERE nm_id = ?').run(text(body.group_name, 100) || null, nowIso(), p.nm_id);
    else db.prepare("UPDATE products SET cost_per_unit = ?, cost_source = 'manual', group_name = ?, updated_at = ? WHERE nm_id = ?").run(cost, text(body.group_name, 100) || null, nowIso(), p.nm_id);
    return { ok: true };
  });

  // ---------- Стратегии и симулятор ----------
  route('GET', '/api/strategies', () => ({ strategies: strategyCatalog() }));

  // ---------- Реклама: кампании WB, прогноз, факт, советы, калькулятор ----------
  route('GET', '/api/ads', () => {
    const settings = getSettings(db);
    return { items: adsOverview(db, settings), targetDrrPct: settings.targetDrrPct };
  });

  route('POST', '/api/ads/calc', ({ body }) => {
    const numOrNull = (v, min, max) => {
      if (v === null || v === undefined || v === '') return null;
      const x = Number(v);
      if (!Number.isFinite(x) || x < min || x > max) throw new HttpError(400, 'BAD_VALUE', 'Проверьте числа: ставка, бюджет, конверсия');
      return x;
    };
    const advertId = Number(body?.advertId);
    const nmId = Number(body?.nmId);
    if (!Number.isInteger(advertId) || !Number.isInteger(nmId)) throw new HttpError(400, 'BAD_VALUE', 'Не указана кампания');
    const result = adsCalc(db, getSettings(db), {
      advertId,
      nmId,
      bid: numOrNull(body.bid, 0.01, 100_000),
      dailyBudget: numOrNull(body.dailyBudget, 1, 10_000_000),
      crPct: numOrNull(body.crPct, 0.01, 100),
      ctrPct: numOrNull(body.ctrPct, 0.01, 100),
      clicksPerDay: numOrNull(body.clicksPerDay, 0, 1_000_000),
    });
    if (!result) throw new HttpError(404, 'NOT_FOUND', 'Кампания не найдена. Обновите данные.');
    return result;
  });

  route('POST', '/api/simulate', ({ body }) => {
    const p = nmIdParam(body.nmId, db);
    const settings = getSettings(db);
    const strategy = getStrategy(body.strategyKey);
    if (!strategy) throw new HttpError(400, 'BAD_STRATEGY', 'Выберите стратегию');
    const days = Math.min(90, Math.max(7, Number(body.days) || 30));
    const baseline = baselineFor(db, p.nm_id, settings);
    return simulate({ baseline, settings, strategyKey: strategy.key, params: body.params || defaultParams(strategy), days, startDate: todayMsk() });
  });

  route('POST', '/api/compare', ({ body }) => {
    const p = nmIdParam(body.nmId, db);
    const settings = getSettings(db);
    const baseline = baselineFor(db, p.nm_id, settings);
    const days = Math.min(90, Math.max(7, Number(body.days) || 30));
    const keys = Array.isArray(body.strategyKeys) && body.strategyKeys.length ? body.strategyKeys.slice(0, 6) : STRATEGIES.map((s) => s.key);
    return {
      results: keys
        .map((k) => getStrategy(k))
        .filter(Boolean)
        .map((s) => {
          const r = simulate({ baseline, settings, strategyKey: s.key, params: (body.params || {})[s.key] || defaultParams(s), days });
          return { key: s.key, name: s.name, totals: r.scenario.totals, base: r.base.totals };
        }),
    };
  });

  // ---------- Планы (выбранные стратегии) ----------
  route('GET', '/api/plans', () => {
    const today = todayMsk();
    return {
      plans: db
        .prepare('SELECT p.*, pr.title AS product_title FROM plans p LEFT JOIN products pr ON pr.nm_id = p.nm_id ORDER BY CASE p.status WHEN \'active\' THEN 0 WHEN \'draft\' THEN 1 ELSE 2 END, p.id DESC')
        .all()
        .map((p) => ({ ...publicPlan(p), progress: p.status === 'active' ? planVsFact(db, p, today) : null })),
    };
  });

  route('GET', '/api/plans/:id', ({ params }) => {
    const plan = getPlan(params.id);
    return { plan: { ...publicPlan(plan), forecast: plan.forecast_json ? JSON.parse(plan.forecast_json) : null }, progress: planVsFact(db, plan, todayMsk()) };
  });

  route('POST', '/api/plans', ({ body }) => {
    const p = nmIdParam(body.nmId, db);
    const strategy = getStrategy(body.strategyKey);
    if (!strategy) throw new HttpError(400, 'BAD_STRATEGY', 'Выберите стратегию');
    const params = normalizeParams(strategy, body.params);
    const settings = getSettings(db);
    const baseline = baselineFor(db, p.nm_id, settings);
    const forecast = simulate({ baseline, settings, strategyKey: strategy.key, params, days: 30, startDate: todayMsk() });
    const now = nowIso();
    const id = db
      .prepare('INSERT INTO plans(nm_id, strategy_key, title, params_json, status, baseline_json, forecast_json, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(p.nm_id, strategy.key, text(body.title, 200) || strategy.name, JSON.stringify(params), 'draft', JSON.stringify(baseline), JSON.stringify(forecast), text(body.note), now, now).lastInsertRowid;
    return { id: Number(id) };
  });

  route('PUT', '/api/plans/:id', ({ params, body }) => {
    const plan = getPlan(params.id);
    db.prepare('UPDATE plans SET title = ?, note = ?, updated_at = ? WHERE id = ?').run(text(body.title, 200) || plan.title, text(body.note), nowIso(), plan.id);
    return { ok: true };
  });

  route('POST', '/api/plans/:id/activate', ({ params, body }) => {
    const plan = getPlan(params.id);
    if (plan.status !== 'draft') throw new HttpError(409, 'NOT_DRAFT', 'Запустить можно только черновик');
    const start = isDate(body.startDate) ? body.startDate : todayMsk();
    const settings = getSettings(db);
    const baseline = baselineFor(db, plan.nm_id, settings);
    const forecast = simulate({ baseline, settings, strategyKey: plan.strategy_key, params: JSON.parse(plan.params_json), days: 30, startDate: start });
    db.prepare("UPDATE plans SET status = 'active', start_date = ?, end_date = ?, baseline_json = ?, forecast_json = ?, updated_at = ? WHERE id = ?").run(
      start,
      addDays(start, 29),
      JSON.stringify(baseline),
      JSON.stringify(forecast),
      nowIso(),
      plan.id,
    );
    const s = getStrategy(plan.strategy_key);
    db.prepare('INSERT INTO journal(date, nm_id, kind, text, created_at) VALUES (?,?,?,?,?)').run(start, plan.nm_id, 'strategy', `Запущена стратегия «${s?.name || plan.strategy_key}»`, nowIso());
    return { ok: true };
  });

  route('POST', '/api/plans/:id/status', ({ params, body }) => {
    const plan = getPlan(params.id);
    const status = body.status;
    if (!['done', 'cancelled'].includes(status)) throw new HttpError(400, 'BAD_STATUS', 'Неверный статус');
    db.prepare('UPDATE plans SET status = ?, end_date = COALESCE(?, end_date), updated_at = ? WHERE id = ?').run(status, plan.status === 'active' ? todayMsk() : null, nowIso(), plan.id);
    if (plan.status === 'active') {
      const s = getStrategy(plan.strategy_key);
      db.prepare('INSERT INTO journal(date, nm_id, kind, text, created_at) VALUES (?,?,?,?,?)').run(todayMsk(), plan.nm_id, 'strategy', `Стратегия «${s?.name || plan.strategy_key}» ${status === 'done' ? 'завершена' : 'отменена'}`, nowIso());
    }
    return { ok: true };
  });

  route('DELETE', '/api/plans/:id', ({ params }) => {
    const plan = getPlan(params.id);
    if (plan.status !== 'draft') throw new HttpError(409, 'NOT_DRAFT', 'Удалить можно только черновик');
    db.prepare('DELETE FROM plans WHERE id = ?').run(plan.id);
    return { ok: true };
  });

  function getPlan(id) {
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(Number(id));
    if (!plan) throw new HttpError(404, 'NOT_FOUND', 'План не найден');
    return plan;
  }
  function publicPlan(p) {
    const s = getStrategy(p.strategy_key);
    const forecast = p.forecast_json ? JSON.parse(p.forecast_json) : null;
    return {
      id: p.id,
      nmId: p.nm_id,
      productTitle: p.product_title,
      strategyKey: p.strategy_key,
      strategyName: s?.name || p.strategy_key,
      title: p.title,
      status: p.status,
      startDate: p.start_date,
      endDate: p.end_date,
      params: JSON.parse(p.params_json),
      note: p.note,
      totals: forecast?.scenario?.totals || null,
      baseTotals: forecast?.base?.totals || null,
      createdAt: p.created_at,
    };
  }

  // ---------- Журнал действий ----------
  route('GET', '/api/journal', () => ({ entries: db.prepare('SELECT j.*, p.title AS product_title FROM journal j LEFT JOIN products p ON p.nm_id = j.nm_id ORDER BY j.date DESC, j.id DESC LIMIT 300').all() }));

  route('POST', '/api/journal', ({ body }) => {
    const t = text(body.text, 1000);
    if (!t) throw new HttpError(400, 'EMPTY', 'Напишите, что сделали');
    const date = isDate(body.date) ? body.date : todayMsk();
    const nmId = body.nmId ? nmIdParam(body.nmId, db).nm_id : null;
    const kind = ['note', 'price', 'content', 'ads', 'stock', 'reviews', 'promo', 'strategy'].includes(body.kind) ? body.kind : 'note';
    const id = db.prepare('INSERT INTO journal(date, nm_id, kind, text, created_at) VALUES (?,?,?,?,?)').run(date, nmId, kind, t, nowIso()).lastInsertRowid;
    return { id: Number(id) };
  });

  route('DELETE', '/api/journal/:id', ({ params }) => {
    db.prepare('DELETE FROM journal WHERE id = ?').run(Number(params.id));
    return { ok: true };
  });

  // ---------- Настройки и синхронизация ----------
  route('GET', '/api/settings', () => ({
    settings: getSettings(db),
    products: db.prepare('SELECT nm_id, title, vendor_code, group_name, cost_per_unit, cost_source, cost_updated_at FROM products WHERE active = 1 ORDER BY sort').all(),
    runs: lastRuns(db, 10),
    syncRunning: isSyncRunning(),
    mock: cfg.mock,
    tokenSet: Boolean(cfg.wbToken),
  }));

  route('PUT', '/api/settings', ({ body }) => {
    try {
      return { settings: saveSettings(db, body || {}) };
    } catch (err) {
      throw new HttpError(400, 'BAD_SETTINGS', err.message);
    }
  });

  route('POST', '/api/sync', ({ body }) => {
    if (isSyncRunning()) throw new HttpError(409, 'RUNNING', 'Сбор данных уже идёт');
    const kind = body.kind === 'full' ? 'full' : 'quick';
    runSync(db, { kind, log }).catch((err) => log.error?.(`[sync] ${err.message}`));
    return { started: true, kind };
  });

  route('GET', '/api/sync', () => ({ runs: lastRuns(db, 10), running: isSyncRunning() }));

  route('GET', '/api/export/claude', ({ res }) => {
    const md = buildClaudeSummary(db, getSettings(db));
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(md);
    return undefined;
  });

  // ---------- Диспетчер ----------
  return async function handle(req, res, url) {
    try {
      const cookies = parseCookies(req.headers.cookie || '');
      const authed = checkSession(cookies[COOKIE_NAME], cfg.sessionSecret);
      const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!match) throw new HttpError(404, 'NOT_FOUND', 'Метод не найден');
      if (match.auth && !authed) throw new HttpError(401, 'UNAUTHORIZED', 'Нужно войти');
      if (req.method !== 'GET') {
        // Защита от подделки запросов с чужих сайтов: свой заголовок + совпадение Origin
        if (req.headers['x-requested-with'] !== 'wb-funnel') throw new HttpError(403, 'CSRF', 'Запрос отклонён');
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== (req.headers['x-forwarded-host'] || req.headers.host)) throw new HttpError(403, 'CSRF', 'Запрос отклонён');
      }
      const m = url.pathname.match(match.re);
      const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
      const result = await match.handler({ req, res, url, params, body, authed });
      if (result !== undefined && !res.writableEnded) send(res, 200, result);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: { code: err.code, message: err.message } });
      log.error?.(`[api] ${req.method} ${url.pathname}: ${err.stack || err.message}`);
      return send(res, 500, { error: { code: 'INTERNAL', message: 'Внутренняя ошибка сервера' } });
    }
  };
}
