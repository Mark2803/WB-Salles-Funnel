// Клиент WB API: авторизация токеном, соблюдение лимитов запросов, повтор при 429/5xx.
// Методы и лимиты — по документации dev.wildberries.ru (снимок от 09.11.2026).

export const WB_HOSTS = {
  analytics: 'https://seller-analytics-api.wildberries.ru',
  advert: 'https://advert-api.wildberries.ru', // статистика кампаний — 3 запроса в минуту
  advertInfo: 'https://advert-api.wildberries.ru', // список кампаний, бюджеты, дневные лимиты — 5 запросов в секунду
  advertRec: 'https://advert-api.wildberries.ru', // рекомендуемые ставки — 5 запросов в минуту
  common: 'https://common-api.wildberries.ru', // тарифы и комиссии WB — 1 запрос в минуту
  prices: 'https://discounts-prices-api.wildberries.ru',
  feedbacks: 'https://feedbacks-api.wildberries.ru',
  finance: 'https://finance-api.wildberries.ru',
};

// Минимальный интервал между запросами к одному сервису (мс), с запасом к лимитам WB
const MIN_INTERVAL_MS = {
  analytics: 21_000, // 3 запроса в минуту
  advert: 21_000, // 3 запроса в минуту
  advertInfo: 400,
  advertRec: 13_000,
  common: 61_000,
  prices: 700, // 10 запросов за 6 секунд
  feedbacks: 400, // 3 запроса в секунду
  finance: 61_000, // 1 запрос в минуту
};

export class WbApiError extends Error {
  constructor(message, { status, service, path, body } = {}) {
    super(message);
    this.name = 'WbApiError';
    this.status = status;
    this.service = service;
    this.path = path;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createWbClient({ token, fetchImpl = globalThis.fetch, now = () => Date.now(), wait = sleep, intervals = MIN_INTERVAL_MS }) {
  const lastCall = {};

  async function throttle(service) {
    const gap = intervals[service] ?? 1000;
    const prev = lastCall[service] ?? 0;
    const delay = prev + gap - now();
    if (delay > 0) await wait(delay);
    lastCall[service] = now();
  }

  async function request(service, method, path, { query, body } = {}) {
    if (!token) throw new WbApiError('Не задан WB_API_TOKEN', { service, path });
    const url = new URL(path, WB_HOSTS[service]);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    for (let attempt = 1; attempt <= 4; attempt++) {
      await throttle(service);
      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers: {
            Authorization: token,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        if (attempt === 4) throw new WbApiError(`Нет связи с WB (${service}): ${err.message}`, { service, path });
        await wait(5_000 * attempt);
        continue;
      }
      const text = await res.text();
      if (res.ok) {
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          throw new WbApiError(`WB вернул не JSON (${service} ${path})`, { status: res.status, service, path });
        }
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const retryAfter = Number(res.headers.get('x-ratelimit-retry') || res.headers.get('retry-after'));
        await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 20_000 * attempt);
        continue;
      }
      throw new WbApiError(explainStatus(res.status, service, path, text), { status: res.status, service, path, body: text.slice(0, 500) });
    }
    throw new WbApiError(`Не удалось выполнить запрос к WB (${service} ${path})`, { service, path });
  }

  return {
    get: (service, path, query) => request(service, 'GET', path, { query }),
    post: (service, path, body, query) => request(service, 'POST', path, { body, query }),
  };
}

function explainStatus(status, service, path, text) {
  const short = (text || '').slice(0, 200);
  if (status === 401) return `WB: токен не подходит или истёк (${service}). ${short}`;
  if (status === 403) return `WB: у токена нет доступа к разделу «${service}» или нужна подписка «Джем». ${short}`;
  if (status === 400) return `WB: неверный запрос ${path}. ${short}`;
  return `WB: ошибка ${status} (${service} ${path}). ${short}`;
}
