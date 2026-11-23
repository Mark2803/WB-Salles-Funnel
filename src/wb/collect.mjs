// Сбор данных из WB API и запись в базу.
// Каждый шаг независим: ошибка одного шага (например, нет подписки «Джем») не ломает остальные.
import { addDays, todayMsk } from '../dates.mjs';
import { nowIso, transaction } from '../db.mjs';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// ---------- Воронка продаж по дням (последние 7 дней — WB дозаполняет данные задним числом) ----------
export function parseFunnelHistory(resp) {
  const rows = [];
  const products = [];
  for (const item of Array.isArray(resp) ? resp : []) {
    const p = item.product || {};
    if (!p.nmId) continue;
    products.push({ nmId: p.nmId, title: p.title, vendorCode: p.vendorCode });
    for (const h of item.history || []) {
      if (!h.date) continue;
      rows.push({
        nmId: p.nmId,
        date: String(h.date).slice(0, 10),
        open: num(h.openCount),
        cart: num(h.cartCount),
        orders: num(h.orderCount),
        orderSum: num(h.orderSum),
        buyouts: num(h.buyoutCount),
        buyoutSum: num(h.buyoutSum),
        buyoutPercent: h.buyoutPercent == null ? null : num(h.buyoutPercent),
        wishlist: num(h.addToWishlistCount),
      });
    }
  }
  return { rows, products };
}

export async function collectFunnel(client, db, nmIds, today = todayMsk()) {
  const start = addDays(today, -6);
  let saved = 0;
  for (const ids of chunk(nmIds, 20)) {
    const resp = await client.post('analytics', '/api/analytics/v3/sales-funnel/products/history', {
      selectedPeriod: { start, end: today },
      nmIds: ids,
      skipDeletedNm: false,
      aggregationLevel: 'day',
    });
    const { rows, products } = parseFunnelHistory(resp);
    transaction(db, () => {
      const up = db.prepare(`INSERT INTO funnel_daily(nm_id, date, open_count, cart_count, order_count, order_sum, buyout_count, buyout_sum, buyout_percent, wishlist_count, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(nm_id, date) DO UPDATE SET open_count=excluded.open_count, cart_count=excluded.cart_count, order_count=excluded.order_count,
          order_sum=excluded.order_sum, buyout_count=excluded.buyout_count, buyout_sum=excluded.buyout_sum, buyout_percent=excluded.buyout_percent,
          wishlist_count=excluded.wishlist_count, updated_at=excluded.updated_at`);
      for (const r of rows) {
        up.run(r.nmId, r.date, r.open, r.cart, r.orders, r.orderSum, r.buyouts, r.buyoutSum, r.buyoutPercent, r.wishlist, nowIso());
        saved++;
      }
      const prod = db.prepare('UPDATE products SET title = COALESCE(?, title), vendor_code = COALESCE(?, vendor_code), updated_at = ? WHERE nm_id = ?');
      for (const p of products) prod.run(p.title || null, p.vendorCode || null, nowIso(), p.nmId);
    });
  }
  return { rows: saved };
}

// ---------- Остатки, рейтинг, срок доставки (сводка за 7 дней) ----------
export function parseFunnelProducts(resp) {
  const list = resp?.data?.products || [];
  return list
    .filter((x) => x?.product?.nmId)
    .map((x) => {
      const p = x.product;
      const sel = x.statistic?.selected || {};
      const t = sel.timeToReady;
      const hours = t ? num(t.days) * 24 + num(t.hours) + num(t.mins) / 60 : null;
      return {
        nmId: p.nmId,
        title: p.title,
        vendorCode: p.vendorCode,
        productRating: p.productRating ?? null,
        feedbackRating: p.feedbackRating ?? null,
        stocksWb: p.stocks?.wb ?? null,
        stocksMp: p.stocks?.mp ?? null,
        deliveryHours: hours && hours > 0 ? hours : null,
      };
    });
}

function upsertSnapshot(db, nmId, date, fields) {
  db.prepare('INSERT INTO snapshot_daily(nm_id, date, updated_at) VALUES (?,?,?) ON CONFLICT(nm_id, date) DO NOTHING').run(nmId, date, nowIso());
  const cols = Object.keys(fields);
  if (!cols.length) return;
  db.prepare(`UPDATE snapshot_daily SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE nm_id = ? AND date = ?`).run(
    ...cols.map((c) => fields[c]),
    nowIso(),
    nmId,
    date,
  );
}

export async function collectProductSummary(client, db, nmIds, today = todayMsk()) {
  const resp = await client.post('analytics', '/api/analytics/v3/sales-funnel/products', {
    selectedPeriod: { start: addDays(today, -6), end: today },
    pastPeriod: { start: addDays(today, -13), end: addDays(today, -7) },
    nmIds,
    skipDeletedNm: false,
    limit: 1000,
    offset: 0,
  });
  const items = parseFunnelProducts(resp);
  transaction(db, () => {
    for (const it of items) {
      upsertSnapshot(db, it.nmId, today, {
        stocks_wb: it.stocksWb,
        stocks_mp: it.stocksMp,
        product_rating: it.productRating,
        feedback_rating: it.feedbackRating,
        delivery_hours: it.deliveryHours,
      });
      db.prepare('UPDATE products SET title = COALESCE(?, title), vendor_code = COALESCE(?, vendor_code) WHERE nm_id = ?').run(it.title || null, it.vendorCode || null, it.nmId);
    }
  });
  return { products: items.length };
}

// ---------- Цены и скидки ----------
export function parsePrices(resp) {
  return (resp?.data?.listGoods || []).map((g) => {
    const size = (g.sizes || [])[0] || {};
    return {
      nmId: g.nmID,
      vendorCode: g.vendorCode,
      price: size.price ?? null,
      sellerPrice: size.discountedPrice ?? null,
      clubPrice: size.clubDiscountedPrice ?? null,
      discountPct: g.discount ?? null,
    };
  });
}

export async function collectPrices(client, db, nmIds, today = todayMsk()) {
  const resp = await client.post('prices', '/api/v2/list/goods/filter', { nmList: nmIds });
  const items = parsePrices(resp);
  transaction(db, () => {
    for (const it of items) {
      upsertSnapshot(db, it.nmId, today, { price: it.price, seller_price: it.sellerPrice, club_price: it.clubPrice, discount_pct: it.discountPct });
    }
  });
  return { products: items.length };
}

// ---------- Реклама ----------
export function parseAdverts(resp, tracked) {
  const set = new Set(tracked);
  return (resp?.adverts || [])
    .map((a) => ({
      advertId: a.id,
      name: a.settings?.name || '',
      status: a.status,
      paymentType: a.settings?.paymentType || '',
      nmIds: (a.nms || []).map((n) => n.nmId).filter((id) => set.has(id)),
      updated: a.timestamps?.updated || a.timestamps?.started || null,
    }))
    .filter((a) => a.nmIds.length > 0);
}

export function parseFullstats(resp, tracked) {
  const set = new Set(tracked);
  const acc = new Map();
  for (const camp of Array.isArray(resp) ? resp : []) {
    for (const day of camp.days || []) {
      const date = String(day.date || '').slice(0, 10);
      if (!date) continue;
      for (const app of day.apps || []) {
        for (const n of app.nms || []) {
          if (!set.has(n.nmId)) continue;
          const key = `${n.nmId}|${date}|${camp.advertId}`;
          const cur = acc.get(key) || { nmId: n.nmId, date, advertId: camp.advertId, views: 0, clicks: 0, atbs: 0, orders: 0, shks: 0, spend: 0, orderSum: 0 };
          cur.views += num(n.views);
          cur.clicks += num(n.clicks);
          cur.atbs += num(n.atbs);
          cur.orders += num(n.orders);
          cur.shks += num(n.shks);
          cur.spend += num(n.sum);
          cur.orderSum += num(n.sum_price);
          acc.set(key, cur);
        }
      }
    }
  }
  return [...acc.values()];
}

export async function collectAds(client, db, nmIds, today = todayMsk()) {
  const adverts = [];
  let next = '';
  for (let page = 0; page < 40; page++) {
    const resp = await client.get('advert', '/api/advert/v3/adverts', { statuses: '7,9,11', limit: 50, next });
    adverts.push(...parseAdverts(resp, nmIds));
    next = resp?.next || '';
    if (!next) break;
  }
  const since = addDays(today, -40);
  const relevant = adverts.filter((a) => a.status !== 7 || !a.updated || String(a.updated).slice(0, 10) >= since);
  transaction(db, () => {
    const up = db.prepare(`INSERT INTO campaigns(advert_id, name, status, payment_type, nm_ids, updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(advert_id) DO UPDATE SET name=excluded.name, status=excluded.status, payment_type=excluded.payment_type, nm_ids=excluded.nm_ids, updated_at=excluded.updated_at`);
    for (const a of adverts) up.run(a.advertId, a.name, a.status, a.paymentType, JSON.stringify(a.nmIds), nowIso());
  });
  let saved = 0;
  for (const ids of chunk(relevant.map((a) => a.advertId), 50)) {
    const resp = await client.get('advert', '/adv/v3/fullstats', { ids: ids.join(','), beginDate: addDays(today, -6), endDate: today });
    const rows = parseFullstats(resp, nmIds);
    transaction(db, () => {
      const up = db.prepare(`INSERT INTO ads_daily(nm_id, date, advert_id, views, clicks, atbs, orders, shks, spend, order_sum) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(nm_id, date, advert_id) DO UPDATE SET views=excluded.views, clicks=excluded.clicks, atbs=excluded.atbs, orders=excluded.orders,
          shks=excluded.shks, spend=excluded.spend, order_sum=excluded.order_sum`);
      for (const r of rows) {
        up.run(r.nmId, r.date, r.advertId, r.views, r.clicks, r.atbs, r.orders, r.shks, r.spend, r.orderSum);
        saved++;
      }
    });
  }
  return { campaigns: relevant.length, rows: saved };
}

// ---------- Поисковые запросы и позиции (только с подпиской «Джем») ----------
export function parseSearchTexts(resp) {
  const items = resp?.data?.items || [];
  let wSum = 0;
  let wPos = 0;
  let wVis = 0;
  let opens = 0;
  let orders = 0;
  const queries = items.map((q) => {
    const open = num(q.openCard?.current);
    const weight = Math.max(1, num(q.frequency?.current));
    wSum += weight;
    wPos += weight * num(q.avgPosition?.current);
    wVis += weight * num(q.visibility?.current);
    opens += open;
    orders += num(q.orders?.current);
    return {
      text: q.text,
      frequency: num(q.frequency?.current),
      weekFrequency: num(q.weekFrequency),
      avgPosition: num(q.avgPosition?.current),
      medianPosition: num(q.medianPosition?.current),
      visibility: num(q.visibility?.current),
      openCard: open,
      addToCart: num(q.addToCart?.current),
      orders: num(q.orders?.current),
    };
  });
  return {
    avgPosition: wSum ? Math.round((wPos / wSum) * 10) / 10 : null,
    visibility: wSum ? Math.round((wVis / wSum) * 10) / 10 : null,
    openCard: opens,
    orders,
    queries,
  };
}

export async function collectSearch(client, db, nmIds, today = todayMsk()) {
  const yesterday = addDays(today, -1);
  let saved = 0;
  for (const nmId of nmIds) {
    const resp = await client.post('analytics', '/api/v2/search-report/product/search-texts', {
      currentPeriod: { start: yesterday, end: yesterday },
      nmIds: [nmId],
      topOrderBy: 'openCard',
      includeSubstitutedSKUs: true,
      includeSearchTexts: true,
      orderBy: { field: 'openCard', mode: 'desc' },
      limit: 30,
    });
    const s = parseSearchTexts(resp);
    db.prepare(`INSERT INTO search_daily(nm_id, date, avg_position, visibility, open_card, orders, queries_json) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(nm_id, date) DO UPDATE SET avg_position=excluded.avg_position, visibility=excluded.visibility, open_card=excluded.open_card,
        orders=excluded.orders, queries_json=excluded.queries_json`).run(nmId, yesterday, s.avgPosition, s.visibility, s.openCard, s.orders, JSON.stringify(s.queries));
    saved++;
  }
  return { products: saved };
}

// ---------- Отзывы ----------
export function parseFeedbacks(resp, tracked, answered) {
  const set = new Set(tracked);
  return (resp?.data?.feedbacks || [])
    .filter((f) => set.has(f.productDetails?.nmId))
    .map((f) => ({
      id: String(f.id),
      nmId: f.productDetails.nmId,
      createdAt: f.createdDate || null,
      rating: f.productValuation ?? null,
      text: f.text || '',
      pros: f.pros || '',
      cons: f.cons || '',
      answered: answered || Boolean(f.answer?.text) ? 1 : 0,
      answerText: f.answer?.text || '',
      orderStatus: f.orderStatus || '',
    }));
}

export async function collectFeedbacks(client, db, nmIds) {
  let saved = 0;
  for (const isAnswered of [false, true]) {
    for (let skip = 0; skip < 5000; skip += 500) {
      const resp = await client.get('feedbacks', '/api/v1/feedbacks', { isAnswered, take: 500, skip, order: 'dateDesc' });
      const list = resp?.data?.feedbacks || [];
      const rows = parseFeedbacks(resp, nmIds, isAnswered);
      transaction(db, () => {
        const up = db.prepare(`INSERT INTO feedbacks(id, nm_id, created_at, rating, text, pros, cons, answered, answer_text, order_status) VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET rating=excluded.rating, text=excluded.text, pros=excluded.pros, cons=excluded.cons,
            answered=excluded.answered, answer_text=excluded.answer_text, order_status=excluded.order_status`);
        for (const r of rows) {
          up.run(r.id, r.nmId, r.createdAt, r.rating, r.text, r.pros, r.cons, r.answered, r.answerText, r.orderStatus);
          saved++;
        }
      });
      if (list.length < 500) break;
    }
  }
  return { rows: saved };
}

// ---------- Финансовый отчёт: реальные комиссия, логистика, хранение ----------
export function parseFinanceLines(resp, tracked) {
  const set = new Set(tracked);
  return (Array.isArray(resp) ? resp : [])
    .filter((l) => set.has(l.nmId))
    .map((l) => ({
      rrdId: l.rrdId,
      nmId: l.nmId,
      date: String(l.rrDate || l.saleDt || '').slice(0, 10),
      docType: l.docTypeName || '',
      operName: l.sellerOperName || '',
      quantity: num(l.quantity),
      retailPriceDisc: num(l.retailPriceWithDisc),
      forPay: num(l.forPay),
      commissionPct: num(l.commissionPercent),
      delivery: num(l.deliveryService),
      storage: num(l.paidStorage),
      acceptance: num(l.paidAcceptance),
      penalty: num(l.penalty),
      deduction: num(l.deduction),
      acquiring: num(l.acquiringFee),
    }));
}

export async function collectFinance(client, db, nmIds, today = todayMsk()) {
  let rrdId = 0;
  let saved = 0;
  for (let page = 0; page < 20; page++) {
    const resp = await client.post('finance', '/api/finance/v1/sales-reports/detailed', {
      dateFrom: addDays(today, -30),
      dateTo: today,
      limit: 100000,
      rrdId,
      period: 'daily',
    });
    if (!Array.isArray(resp) || resp.length === 0) break;
    const rows = parseFinanceLines(resp, nmIds);
    transaction(db, () => {
      const up = db.prepare(`INSERT INTO finance_lines(rrd_id, nm_id, date, doc_type, oper_name, quantity, retail_price_disc, for_pay, commission_pct, delivery, storage, acceptance, penalty, deduction, acquiring)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(rrd_id) DO NOTHING`);
      for (const r of rows) {
        up.run(r.rrdId, r.nmId, r.date, r.docType, r.operName, r.quantity, r.retailPriceDisc, r.forPay, r.commissionPct, r.delivery, r.storage, r.acceptance, r.penalty, r.deduction, r.acquiring);
        saved++;
      }
    });
    rrdId = resp[resp.length - 1].rrdId;
    if (resp.length < 100000) break;
  }
  return { rows: saved };
}
