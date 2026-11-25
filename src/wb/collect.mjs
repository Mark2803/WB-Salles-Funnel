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
    products.push({ nmId: p.nmId, title: p.title, vendorCode: p.vendorCode, subjectId: p.subjectId ?? null, subjectName: p.subjectName ?? null });
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
      const prod = db.prepare(`UPDATE products SET title = COALESCE(?, title), vendor_code = COALESCE(?, vendor_code),
        subject_id = COALESCE(?, subject_id), subject_name = COALESCE(?, subject_name), updated_at = ? WHERE nm_id = ?`);
      for (const p of products) prod.run(p.title || null, p.vendorCode || null, p.subjectId || null, p.subjectName || null, nowIso(), p.nmId);
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
// Статусы кампаний WB: 4 — готова к запуску, 7 — завершена, 9 — активна, 11 — на паузе.
export const CAMPAIGN_STATUS = { 4: 'готова к запуску', 7: 'завершена', 8: 'отменена', 9: 'активна', 11: 'на паузе' };
export const LIVE_STATUSES = [4, 9, 11];
const rubFromKopecks = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v) / 100);

// Ставки WB приходят в двух видах: массив [{ type: 'search', value: 900 }] (так отвечает WB на 25.11.2026)
// или объект { search: 900, recommendations: 0 } (так в документации). Значения — в копейках.
function parseBids(bids) {
  const out = { search: null, recommendations: null };
  if (Array.isArray(bids)) {
    for (const b of bids) if (b && (b.type === 'search' || b.type === 'recommendations')) out[b.type] = rubFromKopecks(b.value ?? b.bid ?? b.bidKopecks);
  } else if (bids && typeof bids === 'object') {
    out.search = rubFromKopecks(bids.search);
    out.recommendations = rubFromKopecks(bids.recommendations);
  }
  return out;
}

// Места показа: массив ['search'] или объект { search: true, recommendations: false }
function parsePlacements(p) {
  if (Array.isArray(p)) return { search: p.includes('search'), recommendations: p.includes('recommendations') };
  if (p && typeof p === 'object') return { search: Boolean(p.search), recommendations: Boolean(p.recommendations) };
  return null;
}

/** Кампании со всеми товарами, ставками (в рублях) и местами показа. */
export function parseAdverts(resp) {
  // WB иногда отдаёт номер кампании как id, иногда как advertId; SQLite не принимает undefined — всё приводим к null
  return (resp?.adverts || [])
    .filter((a) => Number.isFinite(Number(a?.id ?? a?.advertId)))
    .map((a) => ({
      advertId: Number(a.id ?? a.advertId),
      name: a.settings?.name || a.name || '',
      status: a.status ?? null,
      paymentType: a.settings?.paymentType || a.paymentType || '',
      placements: parsePlacements(a.settings?.placements),
      nmIds: (a.nms || []).map((n) => Number(n.nmId)).filter((id) => Number.isFinite(id) && id > 0),
      subjects: (a.nms || []).filter((n) => n.subject?.id).map((n) => ({ nmId: n.nmId, id: n.subject.id, name: n.subject.name || null })),
      // Ставки WB отдаёт в копейках: за клик (cpc) или за 1000 показов (cpm)
      bids: Object.fromEntries((a.nms || []).map((n) => [n.nmId, parseBids(n.bids)])),
      created: a.timestamps?.created || null,
      started: a.timestamps?.started || null,
      updated: a.timestamps?.updated || a.timestamps?.started || null,
    }));
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
          const advertId = Number(camp.advertId ?? camp.id);
          const key = `${n.nmId}|${date}|${advertId}`;
          const cur = acc.get(key) || { nmId: n.nmId, date, advertId, views: 0, clicks: 0, atbs: 0, orders: 0, shks: 0, spend: 0, orderSum: 0 };
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

/** Рекомендуемые ставки WB (в рублях): конкурентная, лидеров, топ-2. */
export function parseBidRecommendations(resp) {
  const out = {};
  for (const r of Array.isArray(resp) ? resp : []) {
    if (!r?.nmId || !r.base) continue;
    out[r.nmId] = {
      competitive: rubFromKopecks(r.base.competitiveBid?.bidKopecks),
      leaders: rubFromKopecks(r.base.leadersBid?.bidKopecks),
      top2: rubFromKopecks(r.base.top2?.bidKopecks),
    };
  }
  return out;
}

/**
 * Реклама: все кампании продавца (включая «готова к запуску»), ставки, бюджет, дневной лимит,
 * рекомендации WB по ставкам и статистика по дням. Товары с действующей рекламой отслеживаются автоматически
 * (возвращаются в extraNmIds).
 */
export async function collectAds(client, db, nmIds, today = todayMsk()) {
  const adverts = [];
  let next = '';
  for (let page = 0; page < 40; page++) {
    const resp = await client.get('advertInfo', '/api/advert/v3/adverts', { statuses: '4,7,9,11', limit: 50, next });
    const parsed = parseAdverts(resp);
    // WB поменял формат ответа — сообщаем, какие поля пришли, чтобы быстро поправить разбор
    if ((resp?.adverts || []).length && !parsed.length) {
      throw new Error(`не удалось разобрать список кампаний WB, поля: ${Object.keys(resp.adverts[0]).join(', ')}`);
    }
    adverts.push(...parsed);
    next = resp?.next || '';
    if (!next) break;
  }
  const since = addDays(today, -40);
  const live = adverts.filter((a) => LIVE_STATUSES.includes(a.status));
  const recentFinished = adverts.filter((a) => a.status === 7 && (!a.updated || String(a.updated).slice(0, 10) >= since));
  const tracked = new Set(nmIds);
  const extraNmIds = [...new Set(live.flatMap((a) => a.nmIds))].filter((id) => !tracked.has(id));
  const statsNmIds = [...nmIds, ...extraNmIds];
  const warnings = [];

  // Бюджет кампании и дневной лимит — для прогноза кликов
  const budgets = {};
  const limits = {};
  if (live.length) {
    try {
      const b = await client.post('advertInfo', '/api/advert/v2/budget', { advertIds: live.map((a) => a.advertId) });
      for (const x of b?.adverts || []) budgets[x.advertId] = num(x.total);
    } catch (err) {
      warnings.push(`бюджет: ${err.message}`);
    }
    try {
      const l = await client.get('advertInfo', '/api/advert/v0/daily-limits', { advertIds: live.map((a) => a.advertId).join(',') });
      for (const x of l?.adverts || []) limits[x.advertId] = { limit: x.enabled ? num(x.dailyLimit) : null, spentToday: x.spentToday == null ? null : num(x.spentToday) };
    } catch (err) {
      warnings.push(`дневной лимит: ${err.message}`);
    }
  }
  // Рекомендуемые ставки WB — для кампаний за клики и за показы, по каждому товару
  const recommended = {};
  for (const a of live.filter((x) => ['cpc', 'cpm'].includes(x.paymentType))) {
    for (const nmId of a.nmIds.slice(0, 5)) {
      try {
        const r = await client.get('advertRec', '/api/advert/v0/bids/recommendations', { nmId, advertId: a.advertId });
        Object.assign((recommended[a.advertId] ||= {}), parseBidRecommendations(r));
      } catch (err) {
        warnings.push(`рекомендуемые ставки: ${err.message}`);
        break;
      }
    }
  }

  transaction(db, () => {
    const up = db.prepare(`INSERT INTO campaigns(advert_id, name, status, payment_type, nm_ids, updated_at, bids_json, placements_json, created_at, started_at, budget_total, daily_limit, spent_today, recommended_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(advert_id) DO UPDATE SET name=excluded.name, status=excluded.status, payment_type=excluded.payment_type, nm_ids=excluded.nm_ids,
        updated_at=excluded.updated_at, bids_json=excluded.bids_json, placements_json=excluded.placements_json, created_at=excluded.created_at,
        started_at=excluded.started_at, budget_total=COALESCE(excluded.budget_total, campaigns.budget_total),
        daily_limit=excluded.daily_limit, spent_today=excluded.spent_today, recommended_json=COALESCE(excluded.recommended_json, campaigns.recommended_json)`);
    for (const a of adverts) {
      up.run(
        a.advertId, a.name, a.status, a.paymentType, JSON.stringify(a.nmIds), nowIso(), JSON.stringify(a.bids), JSON.stringify(a.placements),
        a.created ?? null, a.started ?? null, budgets[a.advertId] ?? null, limits[a.advertId]?.limit ?? null, limits[a.advertId]?.spentToday ?? null,
        recommended[a.advertId] ? JSON.stringify(recommended[a.advertId]) : null,
      );
    }
    const subj = db.prepare('UPDATE products SET subject_id = COALESCE(subject_id, ?), subject_name = COALESCE(subject_name, ?) WHERE nm_id = ?');
    for (const a of adverts) for (const s of a.subjects) subj.run(s.id ?? null, s.name ?? null, Number(s.nmId));
  });

  // Статистика: для новых кампаний — с начала (до 30 дней назад), иначе последние 7 дней
  let saved = 0;
  const withStats = [...live.filter((a) => a.status !== 4), ...recentFinished];
  const hasRows = db.prepare('SELECT 1 FROM ads_daily WHERE advert_id = ? LIMIT 1');
  const groups = new Map();
  for (const a of withStats) {
    const fresh = !hasRows.get(a.advertId);
    const startDay = a.started ? String(a.started).slice(0, 10) : null;
    const begin = fresh ? (startDay && startDay > addDays(today, -29) ? startDay : addDays(today, -29)) : addDays(today, -6);
    if (!groups.has(begin)) groups.set(begin, []);
    groups.get(begin).push(a.advertId);
  }
  for (const [begin, ids] of groups) {
    for (const part of chunk(ids, 50)) {
      const resp = await client.get('advert', '/adv/v3/fullstats', { ids: part.join(','), beginDate: begin > today ? today : begin, endDate: today });
      const rows = parseFullstats(resp, statsNmIds);
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
  }
  return { campaigns: live.length, finished: recentFinished.length, rows: saved, extraNmIds, ...(warnings.length ? { warnings } : {}) };
}

// ---------- Комиссии WB по предметам (тарифы) ----------
export function parseCommission(resp) {
  return (resp?.report || [])
    .filter((r) => r?.subjectID)
    .map((r) => ({
      subjectId: r.subjectID,
      subjectName: r.subjectName || null,
      parentName: r.parentName || null,
      fbwPct: r.paidStorageKgvp == null ? null : num(r.paidStorageKgvp),
      fbsPct: r.kgvpMarketplace == null ? null : num(r.kgvpMarketplace),
    }));
}

/** Комиссия WB по предметам (официальные тарифы, раз в сутки). Нужна для юнит-экономики, пока нет финотчёта. */
export async function collectTariffs(client, db) {
  const list = parseCommission(await client.get('common', '/api/v1/tariffs/commission', { locale: 'ru' }));
  transaction(db, () => {
    const up = db.prepare(`INSERT INTO subject_tariffs(subject_id, subject_name, parent_name, fbw_pct, fbs_pct, updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(subject_id) DO UPDATE SET subject_name=excluded.subject_name, parent_name=excluded.parent_name, fbw_pct=excluded.fbw_pct, fbs_pct=excluded.fbs_pct, updated_at=excluded.updated_at`);
    for (const t of list) up.run(t.subjectId, t.subjectName, t.parentName, t.fbwPct, t.fbsPct, nowIso());
  });
  const used = db.prepare('SELECT DISTINCT p.subject_name, t.fbw_pct FROM products p JOIN subject_tariffs t ON t.subject_id = p.subject_id WHERE p.active = 1').all();
  return { subjects: list.length, used: used.map((u) => `${u.subject_name}: ${u.fbw_pct}%`) };
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
