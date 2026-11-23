// Вход через раздел «Менеджмент» админки Чайного Маркета — как у «Себестоимости» и «Финансовой аналитики».
// После ввода PIN админка выдаёт токен (живёт 60 минут) и открывает инструмент по адресу …/#t=ТОКЕН.
// Здесь токен проверяется по таблице management_access_tokens в базе сайта (храним только sha256 токена).
//
// Без сторонних библиотек: запрос делает утилита psql, которая уже есть на сервере.
// Пароль базы передаётся через переменные окружения процесса psql, а не в командной строке
// (командную строку могут видеть другие пользователи сервера).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

const sha256 = (v) => createHash('sha256').update(v).digest('hex');

// Токен админки — 32 случайных байта в base64url (43 символа)
export function isTokenShape(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(token);
}

// postgresql://user:pass@host:5432/db?schema=public → переменные окружения libpq
export function pgEnvFromUrl(databaseUrl) {
  if (!databaseUrl) throw new Error('Не задан DATABASE_URL (база сайта — для проверки входа из «Менеджмента»).');
  const u = new URL(databaseUrl.split('?')[0].replace(/^postgres(ql)?:/, 'http:'));
  return {
    PGHOST: decodeURIComponent(u.hostname) || 'localhost',
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
    PGCONNECT_TIMEOUT: '5',
  };
}

// Возвращает время окончания токена (мс) или null, если токен не найден / истёк.
export function createManagementVerifier({ databaseUrl, execImpl = execFile }) {
  return async function verify(token) {
    if (!isTokenShape(token)) return null;
    const hash = sha256(token);
    // hash — только [0-9a-f], подставлять в SQL безопасно; дополнительно проверяем
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    const sql = `SELECT (extract(epoch FROM expires_at) * 1000)::bigint FROM management_access_tokens WHERE token_hash = '${hash}' AND expires_at > now() LIMIT 1`;
    const env = { PATH: process.env.PATH || '/usr/bin:/bin', ...pgEnvFromUrl(databaseUrl) };
    const out = await new Promise((resolve, reject) => {
      execImpl('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql], { env, timeout: 10_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`Не удалось проверить доступ по базе сайта: ${String(stderr || err.message).trim().slice(0, 200)}`));
        else resolve(String(stdout).trim());
      });
    });
    const exp = Number(out);
    return Number.isFinite(exp) && exp > Date.now() ? exp : null;
  };
}

// Тестовый режим: подходит только токен «test-token-for-mock-mode»
export function createMockVerifier() {
  return async (token) => (token === 'test-token-for-mock-mode' ? Date.now() + 60 * 60_000 : null);
}
