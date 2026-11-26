// База данных SQLite (встроена в Node 22, отдельная установка не нужна).
// Файл базы: DATA_DIR/wb.sqlite. Схема создаётся и обновляется автоматически при запуске.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Настройки по умолчанию (меняются на вкладке «Настройки»)
// Решение Марка (25.11.2026): никаких придуманных цифр в расходах. Комиссия, логистика, хранение — из тарифов WB
// и финотчёта, объём упаковки — из карточки WB, выкуп — из аналитики WB. Здесь только то, что знает лишь Марк:
// налог (его система налогообложения) и его собственные цели.
export const DEFAULT_SETTINGS = {
  // Налог, % от цены продажи (зависит от системы налогообложения Марка). Пусто — расчёт помечается неполным.
  taxPct: null,
  // Цели и пороги для тревог — выбор Марка, не данные WB
  targetDrrPct: 20,
  targetProfitPerUnit: 80,
  minStockDays: 14,
  minRating: 4.6,
  costPerReviewPoint: 1.46,
};

const MIGRATIONS = [
  // 1 — основная схема
  `
  CREATE TABLE products (
    nm_id INTEGER PRIMARY KEY,
    vendor_code TEXT,
    title TEXT,
    group_name TEXT,
    weight_g REAL,
    cost_per_unit REAL,
    active INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
  );
  CREATE TABLE funnel_daily (
    nm_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    open_count INTEGER NOT NULL DEFAULT 0,
    cart_count INTEGER NOT NULL DEFAULT 0,
    order_count INTEGER NOT NULL DEFAULT 0,
    order_sum REAL NOT NULL DEFAULT 0,
    buyout_count INTEGER NOT NULL DEFAULT 0,
    buyout_sum REAL NOT NULL DEFAULT 0,
    buyout_percent REAL,
    wishlist_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT,
    PRIMARY KEY (nm_id, date)
  );
  CREATE TABLE snapshot_daily (
    nm_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    price REAL,
    discount_pct REAL,
    seller_price REAL,
    club_price REAL,
    stocks_wb INTEGER,
    stocks_mp INTEGER,
    product_rating REAL,
    feedback_rating REAL,
    delivery_hours REAL,
    updated_at TEXT,
    PRIMARY KEY (nm_id, date)
  );
  CREATE TABLE campaigns (
    advert_id INTEGER PRIMARY KEY,
    name TEXT,
    status INTEGER,
    payment_type TEXT,
    nm_ids TEXT,
    updated_at TEXT
  );
  CREATE TABLE ads_daily (
    nm_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    advert_id INTEGER NOT NULL,
    views INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    atbs INTEGER NOT NULL DEFAULT 0,
    orders INTEGER NOT NULL DEFAULT 0,
    shks INTEGER NOT NULL DEFAULT 0,
    spend REAL NOT NULL DEFAULT 0,
    order_sum REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (nm_id, date, advert_id)
  );
  CREATE TABLE search_daily (
    nm_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    avg_position REAL,
    visibility REAL,
    open_card INTEGER,
    orders INTEGER,
    queries_json TEXT,
    PRIMARY KEY (nm_id, date)
  );
  CREATE TABLE feedbacks (
    id TEXT PRIMARY KEY,
    nm_id INTEGER NOT NULL,
    created_at TEXT,
    rating INTEGER,
    text TEXT,
    pros TEXT,
    cons TEXT,
    answered INTEGER NOT NULL DEFAULT 0,
    answer_text TEXT,
    order_status TEXT
  );
  CREATE INDEX feedbacks_nm ON feedbacks(nm_id, created_at);
  CREATE TABLE finance_lines (
    rrd_id INTEGER PRIMARY KEY,
    nm_id INTEGER,
    date TEXT,
    doc_type TEXT,
    oper_name TEXT,
    quantity INTEGER,
    retail_price_disc REAL,
    for_pay REAL,
    commission_pct REAL,
    delivery REAL,
    storage REAL,
    acceptance REAL,
    penalty REAL,
    deduction REAL,
    acquiring REAL
  );
  CREATE INDEX finance_nm ON finance_lines(nm_id, date);
  CREATE TABLE plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nm_id INTEGER NOT NULL,
    strategy_key TEXT NOT NULL,
    title TEXT,
    params_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    start_date TEXT,
    end_date TEXT,
    baseline_json TEXT,
    forecast_json TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    nm_id INTEGER,
    kind TEXT NOT NULL DEFAULT 'note',
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX journal_date ON journal(date);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    kind TEXT NOT NULL,
    details_json TEXT
  );
  `,
  // 2 — откуда взята себестоимость: 'sheet' (лист «Себестоимость» в Финансы V3) или 'manual'
  `
  ALTER TABLE products ADD COLUMN cost_source TEXT;
  ALTER TABLE products ADD COLUMN cost_updated_at TEXT;
  `,
  // 3 — служебные значения (последний список отслеживаемых товаров из таблицы)
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // 4 — реклама подробно: ставки, бюджеты, рекомендации WB; предметы и комиссии WB; снимки прогнозов по кампаниям
  `
  ALTER TABLE campaigns ADD COLUMN bids_json TEXT;
  ALTER TABLE campaigns ADD COLUMN placements_json TEXT;
  ALTER TABLE campaigns ADD COLUMN created_at TEXT;
  ALTER TABLE campaigns ADD COLUMN started_at TEXT;
  ALTER TABLE campaigns ADD COLUMN budget_total REAL;
  ALTER TABLE campaigns ADD COLUMN daily_limit REAL;
  ALTER TABLE campaigns ADD COLUMN spent_today REAL;
  ALTER TABLE campaigns ADD COLUMN recommended_json TEXT;
  ALTER TABLE products ADD COLUMN subject_id INTEGER;
  ALTER TABLE products ADD COLUMN subject_name TEXT;
  CREATE TABLE subject_tariffs (
    subject_id INTEGER PRIMARY KEY,
    subject_name TEXT,
    parent_name TEXT,
    fbw_pct REAL,
    fbs_pct REAL,
    updated_at TEXT
  );
  CREATE TABLE ad_forecasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    advert_id INTEGER NOT NULL,
    nm_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    start_date TEXT NOT NULL,
    reason TEXT,
    inputs_json TEXT NOT NULL,
    forecast_json TEXT NOT NULL
  );
  CREATE INDEX ad_forecasts_campaign ON ad_forecasts(advert_id, nm_id, id);
  `,
  // 5 — когда в последний раз заметили списание из бюджета кампании (WB по API может отдавать «пауза» у работающей кампании)
  `
  ALTER TABLE campaigns ADD COLUMN budget_spent_at TEXT;
  `,
  // 6 — реальные размеры упаковки из карточки WB, тарифы коробов по складам, остатки по складам, история изменений тарифов
  `
  ALTER TABLE products ADD COLUMN length_cm REAL;
  ALTER TABLE products ADD COLUMN width_cm REAL;
  ALTER TABLE products ADD COLUMN height_cm REAL;
  ALTER TABLE products ADD COLUMN weight_kg REAL;
  ALTER TABLE products ADD COLUMN dims_updated_at TEXT;
  CREATE TABLE box_tariffs (
    warehouse TEXT PRIMARY KEY,
    geo TEXT,
    delivery_base REAL,
    delivery_liter REAL,
    delivery_coef REAL,
    storage_base REAL,
    storage_liter REAL,
    storage_coef REAL,
    tariff_date TEXT,
    next_date TEXT,
    updated_at TEXT
  );
  CREATE TABLE stock_wh (
    nm_id INTEGER NOT NULL,
    warehouse TEXT NOT NULL,
    qty INTEGER NOT NULL,
    date TEXT NOT NULL,
    PRIMARY KEY (nm_id, warehouse)
  );
  CREATE TABLE tariff_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    changed_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    item TEXT NOT NULL,
    field TEXT NOT NULL,
    old_value REAL,
    new_value REAL
  );
  `,
  // 7 — финотчёт по всему магазину (не только отслеживаемые товары): количество доставок, склад, артикул — для медиан
  `
  ALTER TABLE finance_lines ADD COLUMN delivery_amount REAL;
  ALTER TABLE finance_lines ADD COLUMN return_amount REAL;
  ALTER TABLE finance_lines ADD COLUMN office_name TEXT;
  ALTER TABLE finance_lines ADD COLUMN vendor_code TEXT;
  ALTER TABLE finance_lines ADD COLUMN subject TEXT;
  ALTER TABLE finance_lines ADD COLUMN bonus_type TEXT;
  CREATE INDEX finance_lines_date ON finance_lines(date);
  `,
  // 8 — «Возмещение издержек по перемещению/перевозке товара» (rebillLogisticCost), чтобы видеть эти расходы
  `
  ALTER TABLE finance_lines ADD COLUMN rebill REAL;
  `,
  // 9 — выкуп по аналитике WB за «закрытый» период (заказы, по которым уже известен итог), по всем карточкам магазина.
  //     nm_id = 0 — весь магазин. Это тот же процент выкупа, что WB показывает в кабинете.
  `
  CREATE TABLE buyout_stats (
    nm_id INTEGER PRIMARY KEY,
    vendor_code TEXT,
    date_from TEXT,
    date_to TEXT,
    orders INTEGER,
    buyouts INTEGER,
    cancels INTEGER,
    updated_at TEXT
  );
  `,
];

export function openDb(dataDir, { memory = false } = {}) {
  let file = ':memory:';
  if (!memory) {
    fs.mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, 'wb.sqlite');
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (!(r.key in DEFAULT_SETTINGS)) continue; // старые настройки с придуманными цифрами больше не используются
    try {
      s[r.key] = JSON.parse(r.value);
    } catch {
      /* пропускаем битое значение */
    }
  }
  return s;
}

export function saveSettings(db, patch) {
  const allowed = Object.keys(DEFAULT_SETTINGS);
  const stmt = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    // Пустое значение — «не задано» (например, налог)
    if (v === null || v === '') {
      db.prepare('DELETE FROM settings WHERE key = ?').run(k);
      continue;
    }
    const num = Number(v);
    if (!Number.isFinite(num) || num < 0) throw new Error(`Некорректное значение «${k}»`);
    stmt.run(k, JSON.stringify(num));
  }
  return getSettings(db);
}

// Гарантирует, что все отслеживаемые артикулы есть в таблице products
export function ensureProducts(db, nmIds) {
  const stmt = db.prepare('INSERT INTO products(nm_id, sort, updated_at) VALUES (?, ?, ?) ON CONFLICT(nm_id) DO NOTHING');
  nmIds.forEach((id, i) => stmt.run(id, i, nowIso()));
  // Товары, убранные из списка (галочка «Воронка WB» в Менеджменте или TRACKED_NM_IDS), скрываем — данные не удаляем
  const placeholders = nmIds.map(() => '?').join(',') || 'NULL';
  db.prepare(`UPDATE products SET active = CASE WHEN nm_id IN (${placeholders}) THEN 1 ELSE 0 END`).run(...nmIds);
  const order = db.prepare('UPDATE products SET sort = ? WHERE nm_id = ?');
  nmIds.forEach((id, i) => order.run(i, id));
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
