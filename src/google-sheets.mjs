// Чтение Google Таблицы от имени робота (служебного аккаунта) без сторонних библиотек.
// Тот же подход и тот же ключ, что у «Себестоимости» в Менеджменте (репозиторий Managment, google-sheets.ts),
// но доступ только на чтение (scope spreadsheets.readonly).
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const b64url = (value) => Buffer.from(value).toString('base64url');

export function createSheetsReader({ keyFile, spreadsheetId, fetchImpl = globalThis.fetch }) {
  let key = null;
  let cached = null;

  function loadKey() {
    if (key) return key;
    if (!keyFile) throw new Error('Не задан GOOGLE_SERVICE_ACCOUNT_FILE (путь к ключу робота Google).');
    const parsed = JSON.parse(readFileSync(keyFile, 'utf8'));
    if (!parsed.client_email || !parsed.private_key) throw new Error('Файл ключа Google повреждён: нет client_email или private_key.');
    key = { email: parsed.client_email, privateKey: parsed.private_key };
    return key;
  }

  async function accessToken() {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
    const k = loadKey();
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
      JSON.stringify({ iss: k.email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }),
    )}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(k.privateKey).toString('base64url');
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Google не пустил робота (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    cached = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return cached.value;
  }

  // Значения без форматирования: числа приходят числами («165,35» → 165.35)
  async function getValues(range) {
    if (!spreadsheetId) throw new Error('Не задан COSTS_SPREADSHEET_ID (id таблицы «Финансы V3»).');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Google Таблица ответила ошибкой ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()).values ?? [];
  }

  return { getValues };
}

export const sheetRange = (sheet, a1) => `'${sheet.replace(/'/g, "''")}'!${a1}`;
