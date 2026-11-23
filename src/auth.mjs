// Вход по паролю. Пароль хранится только в виде хэша (scrypt) в .env.
// Сессия — подписанная cookie (HMAC-SHA256) со сроком действия 12 часов.
import crypto from 'node:crypto';

const SESSION_HOURS = 12;
export const COOKIE_NAME = 'wb_funnel_session';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384;
  const key = crypto.scryptSync(password, salt, 64, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || !stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const salt = Buffer.from(parts[2], 'base64');
  const expected = Buffer.from(parts[3], 'base64');
  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length, { N, r: 8, p: 1 });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createSession(secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ exp: now + SESSION_HOURS * 3600_000 })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function checkSession(token, secret, now = Date.now()) {
  if (!token || typeof token !== 'string') return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof data.exp === 'number' && data.exp > now;
  } catch {
    return false;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(value, { secure, path, maxAgeSec }) {
  const attrs = [`${COOKIE_NAME}=${value}`, `Path=${path || '/'}`, 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

// Ограничение попыток входа: не больше 5 за 10 минут с одного адреса
const attempts = new Map();
export function loginAllowed(ip, now = Date.now()) {
  const windowMs = 10 * 60_000;
  const list = (attempts.get(ip) || []).filter((t) => now - t < windowMs);
  attempts.set(ip, list);
  return list.length < 5;
}
export function registerFailedLogin(ip, now = Date.now()) {
  const list = attempts.get(ip) || [];
  list.push(now);
  attempts.set(ip, list);
}
export function resetLogin(ip) {
  attempts.delete(ip);
}

export const SESSION_MAX_AGE_SEC = SESSION_HOURS * 3600;
