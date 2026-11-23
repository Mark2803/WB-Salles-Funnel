// База данных SQLite (встроена в Node 22, отдельная установка не нужна).
// Файл базы: DATA_DIR/wb.sqlite. Схема создаётся и обновляется автоматически при запуске.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Настройки по умолчанию (меняются на вкладке «Настройки»)
export const DEFAULT_SETTINGS = {
  // Юнит-экономика: используется, пока нет данных финотчёта WB
  commissionPct: 17,
  acquiringPct: 2,
  taxPct: 6,
  logisticsPerDelivery: 45,
  returnLogistics: 50,
  storagePerUnit: 5,
  defaultBuyoutPct: 95,
  defaultCostPerUnit: 0,
  // Цели и пороги для тревог
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
  // Артикулы, убранные из TRACKED_NM_IDS, скрываем (данные не удаляем)
  const placeholders = nmIds.map(() => '?').join(',') || 'NULL';
  db.prepare(`UPDATE products SET active = CASE WHEN nm_id IN (${placeholders}) THEN 1 ELSE 0 END`).run(...nmIds);
  const order = db.prepare('UPDATE products SET sort = ? WHERE nm_id = ?');
  nmIds.forEach((id, i) => order.run(i, id));
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
