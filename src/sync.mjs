// Запуск сбора данных: «быстрый» (воронка, остатки, цены, реклама) каждые N часов
// и «полный» (плюс отзывы, финотчёт, поисковые запросы) раз в сутки.
import { config } from './config.mjs';
import { nowIso, ensureProducts, getMeta, setMeta } from './db.mjs';
import { todayMsk } from './dates.mjs';
import { createWbClient } from './wb/client.mjs';
import { createMockClient } from './wb/mock.mjs';
import * as collect from './wb/collect.mjs';
import { collectCosts, createCostsSource } from './costs.mjs';
import { createMockCostsSource } from './wb/mock.mjs';

let running = null;

export function makeClient(cfg = config) {
  return cfg.mock ? createMockClient({ nmIds: cfg.trackedNmIds }) : createWbClient({ token: cfg.wbToken });
}

export function makeCostsSource(cfg = config) {
  return cfg.mock ? createMockCostsSource() : createCostsSource(cfg);
}

const STEPS = {
  funnel: { label: 'Воронка по дням', fn: collect.collectFunnel },
  summary: { label: 'Остатки и рейтинг', fn: collect.collectProductSummary },
  prices: { label: 'Цены', fn: collect.collectPrices },
  costs: { label: 'Себестоимость (таблица «Финансы V3»)', fn: (client, db, nmIds, today, ctx) => collectCosts(ctx.costsSource, db) },
  ads: { label: 'Реклама', fn: collect.collectAds },
  feedbacks: { label: 'Отзывы', fn: collect.collectFeedbacks },
  finance: { label: 'Финансовый отчёт', fn: collect.collectFinance },
  search: { label: 'Поиск и позиции («Джем»)', fn: collect.collectSearch },
};

export const QUICK = ['funnel', 'summary', 'prices', 'costs', 'ads'];
export const FULL = ['funnel', 'summary', 'prices', 'costs', 'ads', 'feedbacks', 'finance', 'search'];

export function isSyncRunning() {
  return Boolean(running);
}

const TRACKED_KEY = 'tracked_nm_ids';

/** Последний известный список отслеживаемых товаров (для запуска сервера до первого сбора). */
export function savedTrackedNmIds(db, fallback = config.trackedNmIds) {
  const saved = getMeta(db, TRACKED_KEY);
  return Array.isArray(saved) ? saved : fallback;
}

/**
 * Какие товары отслеживать: галочки «Воронка WB» в Менеджменте (колонка в листе «Себестоимость»).
 * Пока колонки нет — TRACKED_NM_IDS из .env. Если таблица недоступна — последний известный список.
 */
export async function resolveTrackedNmIds(db, { costsSource, fallback = config.trackedNmIds, log = console } = {}) {
  try {
    const tracked = costsSource?.readTracked ? await costsSource.readTracked() : { hasColumn: false, nmIds: [] };
    if (tracked.hasColumn) {
      setMeta(db, TRACKED_KEY, tracked.nmIds);
      return { nmIds: tracked.nmIds, source: 'sheet' };
    }
    return { nmIds: fallback, source: 'env' };
  } catch (err) {
    log.warn?.(`[sync] список товаров из таблицы не прочитан: ${err.message}`);
    const saved = getMeta(db, TRACKED_KEY);
    return Array.isArray(saved) ? { nmIds: saved, source: 'saved', error: err.message } : { nmIds: fallback, source: 'env', error: err.message };
  }
}

const SOURCE_LABEL = { sheet: 'галочки «Воронка WB» в Менеджменте', env: 'TRACKED_NM_IDS в .env', saved: 'последний известный список (таблица недоступна)' };

export async function runSync(db, { kind = 'quick', client = makeClient(), costsSource = makeCostsSource(), nmIds: givenNmIds, today = todayMsk(), log = console } = {}) {
  if (running) return { alreadyRunning: true, runId: running };
  const tracked = givenNmIds ? { nmIds: givenNmIds, source: 'env' } : await resolveTrackedNmIds(db, { costsSource, log });
  const nmIds = tracked.nmIds;
  ensureProducts(db, nmIds);
  const steps = kind === 'full' ? FULL : QUICK;
  const runId = Number(db.prepare('INSERT INTO sync_runs(started_at, status, kind) VALUES (?,?,?)').run(nowIso(), 'running', kind).lastInsertRowid);
  running = runId;
  const details = [{
    step: 'products',
    label: 'Список товаров',
    ok: !tracked.error,
    ...(tracked.error ? { error: tracked.error } : {}),
    result: { count: nmIds.length, source: SOURCE_LABEL[tracked.source] },
    ms: 0,
  }];
  try {
    for (const key of nmIds.length ? steps : []) {
      const step = STEPS[key];
      const startedAt = Date.now();
      try {
        const result = await step.fn(client, db, nmIds, today, { costsSource });
        details.push({ step: key, label: step.label, ok: true, result, ms: Date.now() - startedAt });
      } catch (err) {
        log.warn?.(`[sync] ${step.label}: ${err.message}`);
        details.push({ step: key, label: step.label, ok: false, error: err.message, status: err.status ?? null, ms: Date.now() - startedAt });
      }
      db.prepare('UPDATE sync_runs SET details_json = ? WHERE id = ?').run(JSON.stringify(details), runId);
    }
    const failed = details.filter((d) => !d.ok);
    const status = failed.length === 0 ? 'ok' : failed.length === details.length ? 'error' : 'partial';
    db.prepare('UPDATE sync_runs SET finished_at = ?, status = ?, details_json = ? WHERE id = ?').run(nowIso(), status, JSON.stringify(details), runId);
    return { runId, status, details };
  } finally {
    running = null;
  }
}

export function lastRuns(db, limit = 10) {
  return db
    .prepare('SELECT id, started_at, finished_at, status, kind, details_json FROM sync_runs ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((r) => ({ ...r, details: r.details_json ? JSON.parse(r.details_json) : [] }));
}

// Планировщик: проверяет каждые 10 минут, пора ли запускать сбор
export function startScheduler(db, { everyHours = config.syncEveryHours, log = console } = {}) {
  const tick = async () => {
    try {
      const lastFull = db.prepare("SELECT started_at FROM sync_runs WHERE kind = 'full' AND status != 'running' ORDER BY id DESC LIMIT 1").get();
      const lastAny = db.prepare("SELECT started_at FROM sync_runs WHERE status != 'running' ORDER BY id DESC LIMIT 1").get();
      const today = todayMsk();
      const fullDoneToday = lastFull && todayMsk(Date.parse(lastFull.started_at)) === today;
      const hoursSinceAny = lastAny ? (Date.now() - Date.parse(lastAny.started_at)) / 3600_000 : Infinity;
      if (!fullDoneToday) await runSync(db, { kind: 'full', log });
      else if (hoursSinceAny >= everyHours) await runSync(db, { kind: 'quick', log });
    } catch (err) {
      log.error?.(`[scheduler] ${err.message}`);
    }
  };
  // Зависший «running» после перезапуска сервера помечаем как прерванный
  db.prepare("UPDATE sync_runs SET status = 'error', finished_at = ? WHERE status = 'running'").run(nowIso());
  setTimeout(tick, 15_000);
  return setInterval(tick, 10 * 60_000);
}
