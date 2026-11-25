// Настройки приложения из файла .env и переменных окружения.
// Простой разбор .env без сторонних библиотек: KEY=VALUE, строки с # — комментарии.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadEnvFile() {
  const file = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(file)) return {};
  return parseEnv(fs.readFileSync(file, 'utf8'));
}

const fileEnv = loadEnvFile();
// Переменные окружения процесса важнее файла .env
const env = (key, def = '') => (process.env[key] ?? fileEnv[key] ?? def);

function parseIds(text) {
  return String(text)
    .split(/[\s,;]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export const config = {
  host: env('HOST', '127.0.0.1'),
  port: Number(env('PORT', '3300')),
  basePath: env('BASE_PATH', '/management/wb-funnel').replace(/\/$/, '') || '/',
  wbToken: env('WB_API_TOKEN', ''),
  // База сайта Чайного Маркета — только для проверки входа из «Менеджмента»
  databaseUrl: env('DATABASE_URL', ''),
  sessionSecret: env('SESSION_SECRET', ''),
  dataDir: path.resolve(ROOT_DIR, env('DATA_DIR', './data')),
  trackedNmIds: parseIds(env('TRACKED_NM_IDS', '')),
  syncEveryHours: Math.max(1, Number(env('SYNC_EVERY_HOURS', '1')) || 1),
  mock: env('WB_MOCK', '0') === '1',
  // Себестоимость — из Google Таблицы «Финансы V3» (тот же ключ робота, что у Менеджмента)
  googleKeyFile: env('GOOGLE_SERVICE_ACCOUNT_FILE', ''),
  costsSpreadsheetId: env('COSTS_SPREADSHEET_ID', ''),
  costsSheet: env('COSTS_SHEET', 'Себестоимость'),
  cookieSecure: env('COOKIE_SECURE', '1') === '1',
};

// Проверка настроек при запуске: возвращает список ошибок и предупреждений.
export function checkConfig(cfg = config) {
  const errors = [];
  const warnings = [];
  if (!cfg.mock && !cfg.databaseUrl) errors.push('Не задан DATABASE_URL — без него не проверить вход из «Менеджмента» (взять из /home/ivanc1539/tea-market-v2/backend/.env)');
  if (!cfg.sessionSecret || cfg.sessionSecret.length < 32) errors.push('SESSION_SECRET должен быть не короче 32 символов');
  const sheetConfigured = Boolean(cfg.googleKeyFile && cfg.costsSpreadsheetId);
  if (!cfg.trackedNmIds.length && !sheetConfigured) errors.push('Нет списка товаров: задайте TRACKED_NM_IDS или подключите таблицу (галочки «Воронка WB» в Менеджменте)');
  if (!cfg.mock && !cfg.wbToken) warnings.push('Не задан WB_API_TOKEN — сбор данных работать не будет');
  if (!cfg.mock && (!cfg.googleKeyFile || !cfg.costsSpreadsheetId)) warnings.push('Не заданы GOOGLE_SERVICE_ACCOUNT_FILE / COSTS_SPREADSHEET_ID — себестоимость из таблицы подтягиваться не будет');
  if (cfg.mock) warnings.push('Включён тестовый режим WB_MOCK=1 — данные выдуманные');
  return { errors, warnings };
}
