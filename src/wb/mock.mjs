// Тестовый режим (WB_MOCK=1): выдуманные ответы в формате WB API.
// Нужен, чтобы проверить интерфейс и расчёты без токена. Данные НЕ настоящие.
import { addDays, dateRange, todayMsk } from '../dates.mjs';

// Реальные названия и цены артикулов (с витрины WB на 23.11.2026) — только для правдоподобного вида
const KNOWN = {
  1293796729: { title: 'Смола Шу Пуэра, Чайная паста Ча Гао, 3 грамма (5 штук)', vendor: 'SMOLA-SMILE-3,5', price: 900, disc: 66 },
  1293810594: { title: 'Смола Шу Пуэра, Чайная паста Ча Гао, 5 грамм (10 штук)', vendor: 'SMOLA-SMILE-7', price: 1150, disc: 41 },
  1293819178: { title: 'Смола Шу Пуэра, Чайная паста Ча Гао, 8 грамм (15 штук)', vendor: 'SMOLA-SMILE-10,5', price: 1450, disc: 42 },
  1293824574: { title: 'Смола Шу Пуэра, Чайная паста Ча Гао, 13 грамм (25 штук)', vendor: 'SMOLA-SMILE-17,5', price: 2150, disc: 41 },
  1293830368: { title: 'Смола Шу Пуэра, Чайная паста Ча Гао, 25 грамм (50 штук)', vendor: 'SMOLA-SMILE-35', price: 3700, disc: 45 },
  1293530574: { title: 'Смола ГАБА Чайная паста (cha gao) 1,6 г. (2 шт.)', vendor: 'SMOLA-GABA-2', price: 600, disc: 30 },
  1293550875: { title: 'Смола ГАБА Чайная паста (cha gao) 4,8 г. (6 шт.)', vendor: 'SMOLA-GABA-6', price: 1100, disc: 24 },
  1293557865: { title: 'Смола ГАБА Чайная паста (cha gao) 8 г. (10 шт.)', vendor: 'SMOLA-GABA-10', price: 1600, disc: 32 },
  1293561361: { title: 'Смола ГАБА Чайная паста (cha gao) 12 г. (15 шт.)', vendor: 'SMOLA-GABA-15', price: 2050, disc: 30 },
  1293566093: { title: 'Смола ГАБА Чайная паста (cha gao) 16 г. (20 шт.)', vendor: 'SMOLA-GABA-20', price: 2500, disc: 40 },
};

function rng(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function info(nmId) {
  return KNOWN[nmId] || { title: `Товар ${nmId}`, vendor: `SKU-${nmId}`, price: 1000, disc: 30 };
}

function dayStats(nmId, date) {
  const r = rng(nmId % 100000 + Number(date.replaceAll('-', '')) % 100000);
  const base = 25 + (nmId % 7) * 8;
  const open = Math.round(base * (0.6 + r()));
  const cart = Math.round(open * (0.08 + r() * 0.12));
  const orders = Math.round(cart * (0.4 + r() * 0.3));
  const it = info(nmId);
  const avg = Math.round(it.price * (1 - it.disc / 100) * 0.9);
  const buyouts = Math.round(orders * 0.93);
  return { open, cart, orders, orderSum: orders * avg, buyouts, buyoutSum: buyouts * avg, wishlist: Math.round(open * 0.05) };
}

export function createMockClient({ nmIds, today = todayMsk() }) {
  const tracked = nmIds;
  return {
    async get(service, path, query = {}) {
      if (path === '/api/advert/v3/adverts') {
        return {
          adverts: [
            {
              id: 900001,
              status: 9,
              timestamps: { updated: `${today}T08:00:00Z` },
              settings: { paymentType: 'cpc', name: 'Шу Пуэр 8 г — клики', placements: { search: true, recommendations: false } },
              nms: [{ nmId: tracked[2] ?? tracked[0], bids: { search: 8 } }],
            },
          ],
          next: '',
        };
      }
      if (path === '/adv/v3/fullstats') {
        const days = dateRange(query.beginDate, query.endDate).map((date) => {
          const r = rng(Number(date.replaceAll('-', '')) % 100000);
          const views = Math.round(400 + r() * 400);
          const clicks = Math.round(views * (0.025 + r() * 0.015));
          const orders = Math.round(clicks * 0.08 + r());
          const nmId = tracked[2] ?? tracked[0];
          return {
            date: `${date}T00:00:00Z`,
            apps: [{ appType: 32, nms: [{ nmId, name: info(nmId).title, views, clicks, atbs: Math.round(clicks * 0.15), orders, shks: orders, sum: Math.round(clicks * 8), sum_price: orders * 800 }] }],
          };
        });
        return [{ advertId: 900001, days }];
      }
      if (path === '/api/v1/feedbacks') {
        if (query.skip > 0) return { data: { feedbacks: [] } };
        const list = query.isAnswered === false || query.isAnswered === 'false'
          ? [{ id: 'mock-neg-1', text: 'Пришло раскрошенным', pros: '', cons: 'Крошка', productValuation: 2, createdDate: `${addDays(today, -1)}T10:00:00Z`, productDetails: { nmId: tracked[6] ?? tracked[0] }, orderStatus: 'buyout' }]
          : [{ id: 'mock-pos-1', text: 'Вкусно, растворяется быстро', pros: 'Вкус', cons: '', productValuation: 5, createdDate: `${addDays(today, -3)}T10:00:00Z`, productDetails: { nmId: tracked[0] }, answer: { text: 'Спасибо!' }, orderStatus: 'buyout' }];
        return { data: { feedbacks: list } };
      }
      throw new Error(`Тестовый режим: нет ответа для GET ${path}`);
    },
    async post(service, path, body = {}) {
      if (path === '/api/analytics/v3/sales-funnel/products/history') {
        return body.nmIds.map((nmId) => ({
          product: { nmId, title: info(nmId).title, vendorCode: info(nmId).vendor, brandName: '', subjectId: 406, subjectName: 'Чай' },
          history: dateRange(body.selectedPeriod.start, body.selectedPeriod.end).map((date) => {
            const s = dayStats(nmId, date);
            return {
              date,
              openCount: s.open,
              cartCount: s.cart,
              orderCount: s.orders,
              orderSum: s.orderSum,
              buyoutCount: s.buyouts,
              buyoutSum: s.buyoutSum,
              buyoutPercent: 93,
              addToCartConversion: s.open ? Math.round((s.cart / s.open) * 100) : 0,
              cartToOrderConversion: s.cart ? Math.round((s.orders / s.cart) * 100) : 0,
              addToWishlistCount: s.wishlist,
            };
          }),
          currency: 'RUB',
        }));
      }
      if (path === '/api/analytics/v3/sales-funnel/products') {
        return {
          data: {
            products: body.nmIds.map((nmId, i) => ({
              product: {
                nmId,
                title: info(nmId).title,
                vendorCode: info(nmId).vendor,
                productRating: nmId === 1293530574 || nmId === 1293550875 ? 2.7 : 4.8,
                feedbackRating: nmId === 1293530574 || nmId === 1293550875 ? 2.7 : 4.9,
                stocks: { wb: [76, 50, 30, 20, 10, 0, 75, 50, 30, 20][i] ?? 25, mp: 0, balanceSum: 0 },
              },
              statistic: { selected: { timeToReady: { days: 1, hours: 4, mins: 0 } } },
            })),
            currency: 'RUB',
          },
        };
      }
      if (path === '/api/v2/list/goods/filter') {
        return {
          data: {
            listGoods: body.nmList.map((nmId) => {
              const it = info(nmId);
              return { nmID: nmId, vendorCode: it.vendor, discount: it.disc, sizes: [{ price: it.price, discountedPrice: Math.round(it.price * (1 - it.disc / 100)), clubDiscountedPrice: Math.round(it.price * (1 - it.disc / 100) * 0.97) }] };
            }),
          },
        };
      }
      if (path === '/api/v2/search-report/product/search-texts') {
        const nmId = body.nmIds[0];
        const r = rng(nmId % 99991);
        return {
          data: {
            items: ['чайная паста', 'ча гао', 'пуэр шу', 'смола пуэра', 'растворимый пуэр'].map((text, k) => ({
              text,
              frequency: { current: Math.round(500 / (k + 1)) },
              weekFrequency: Math.round(3500 / (k + 1)),
              avgPosition: { current: Math.round(20 + r() * 150) },
              medianPosition: { current: Math.round(20 + r() * 150) },
              visibility: { current: Math.round(r() * 40) },
              openCard: { current: Math.round(r() * 10) },
              addToCart: { current: Math.round(r() * 3) },
              orders: { current: Math.round(r() * 2) },
            })),
          },
        };
      }
      if (path === '/api/finance/v1/sales-reports/detailed') {
        if (body.rrdId > 0) return null;
        const lines = [];
        let id = 1;
        for (const nmId of tracked) {
          for (const date of dateRange(body.dateFrom, addDays(body.dateTo, -1))) {
            const s = dayStats(nmId, date);
            if (!s.buyouts) continue;
            const price = Math.round(info(nmId).price * (1 - info(nmId).disc / 100));
            lines.push({ rrdId: id++, nmId, rrDate: date, docTypeName: 'Продажа', sellerOperName: 'Продажа', quantity: s.buyouts, retailPriceWithDisc: String(price * s.buyouts), forPay: String(Math.round(price * s.buyouts * 0.8)), commissionPercent: 17, deliveryService: '0', paidStorage: '0', paidAcceptance: '0', penalty: '0', deduction: '0', acquiringFee: String(Math.round(price * s.buyouts * 0.02)) });
            lines.push({ rrdId: id++, nmId, rrDate: date, docTypeName: '', sellerOperName: 'Логистика', quantity: 0, retailPriceWithDisc: '0', forPay: '0', commissionPercent: 0, deliveryService: String(46 * s.orders), paidStorage: '0', paidAcceptance: '0', penalty: '0', deduction: '0', acquiringFee: '0' });
          }
        }
        return lines;
      }
      throw new Error(`Тестовый режим: нет ответа для POST ${path}`);
    },
  };
}
