// Расчёт показателей: воронка за период, реклама, юнит-экономика, остатки, тревоги.
import { addDays, dateRange, todayMsk } from './dates.mjs';

const round = (v, d = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const div = (a, b) => (b ? a / b : null);

// ---------- Юнит-экономика ----------
// Та же формула, что в калькуляторе: прибыль = цена × (1 − комиссия − эквайринг − налог) − расходы на штуку
export function unitEconomics({ price, cost, settings, actual = null }) {
  const buyout = (actual?.buyoutPct ?? settings.defaultBuyoutPct) / 100 || 0.95;
  const commissionPct = actual?.commissionPct ?? settings.commissionPct;
  const pctShare = (commissionPct + settings.acquiringPct + settings.taxPct) / 100;
  // Логистика на выкупленную штуку: из финотчёта (уже включает невыкупы) или по формуле
  const logisticsPerSold = actual?.logisticsPerSold ?? settings.logisticsPerDelivery / buyout + settings.returnLogistics * (1 / buyout - 1);
  const storage = actual?.storagePerSold ?? settings.storagePerUnit;
  const hasCost = cost != null && cost > 0;
  const fixed = (hasCost ? cost : 0) + logisticsPerSold + storage;
  const profit = price != null ? price * (1 - pctShare) - fixed : null;
  return {
    price,
    cost: hasCost ? cost : null,
    commissionPct: round(commissionPct, 1),
    logisticsPerSold: round(logisticsPerSold, 0),
    storagePerSold: round(storage, 0),
    pctShare,
    fixedPerUnit: fixed,
    profitPerUnit: hasCost && profit != null ? round(profit, 0) : null,
    marginPct: hasCost && price ? round((profit / price) * 100, 1) : null,
    breakEvenPrice: hasCost ? round(fixed / (1 - pctShare), 0) : null,
    maxAdPerSale: hasCost && profit != null ? round(Math.max(0, profit), 0) : null,
    workAdPerSale: hasCost && profit != null ? round(Math.max(0, profit - settings.targetProfitPerUnit), 0) : null,
    source: actual ? 'finance' : 'settings',
  };
}

// Фактические комиссия и логистика за 30 дней из финотчёта WB
export function actualCosts(db, nmId, today = todayMsk()) {
  const from = addDays(today, -30);
  const r = db
    .prepare(`SELECT
        SUM(CASE WHEN oper_name LIKE 'Продажа%' THEN quantity ELSE 0 END) AS sold,
        SUM(CASE WHEN oper_name LIKE 'Возврат%' THEN quantity ELSE 0 END) AS returned,
        AVG(CASE WHEN oper_name LIKE 'Продажа%' AND commission_pct > 0 THEN commission_pct END) AS commission,
        SUM(delivery) AS delivery, SUM(storage) AS storage, SUM(acceptance) AS acceptance,
        SUM(penalty) AS penalty, SUM(deduction) AS deduction
      FROM finance_lines WHERE nm_id = ? AND date >= ?`)
    .get(nmId, from);
  const net = (r?.sold || 0) - (r?.returned || 0);
  if (!r || net < 3) return null; // мало продаж — оценка ненадёжна
  return {
    soldUnits: net,
    commissionPct: r.commission ?? null,
    logisticsPerSold: (r.delivery || 0) / net,
    storagePerSold: ((r.storage || 0) + (r.acceptance || 0)) / net,
    penalties: (r.penalty || 0) + (r.deduction || 0),
  };
}

// ---------- Воронка и реклама за период ----------
export function periodMetrics(db, nmId, from, to) {
  const f = db
    .prepare(`SELECT COALESCE(SUM(open_count),0) open, COALESCE(SUM(cart_count),0) cart, COALESCE(SUM(order_count),0) orders,
        COALESCE(SUM(order_sum),0) orderSum, COALESCE(SUM(buyout_count),0) buyouts, COALESCE(SUM(buyout_sum),0) buyoutSum,
        COALESCE(SUM(wishlist_count),0) wishlist, AVG(buyout_percent) buyoutPct, COUNT(*) days
      FROM funnel_daily WHERE nm_id = ? AND date BETWEEN ? AND ?`)
    .get(nmId, from, to);
  const a = db
    .prepare(`SELECT COALESCE(SUM(views),0) views, COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(atbs),0) atbs,
        COALESCE(SUM(orders),0) orders, COALESCE(SUM(spend),0) spend, COALESCE(SUM(order_sum),0) orderSum
      FROM ads_daily WHERE nm_id = ? AND date BETWEEN ? AND ?`)
    .get(nmId, from, to);
  return {
    from,
    to,
    days: f.days,
    open: f.open,
    cart: f.cart,
    orders: f.orders,
    orderSum: f.orderSum,
    buyouts: f.buyouts,
    buyoutSum: f.buyoutSum,
    wishlist: f.wishlist,
    cartConv: round(div(f.cart, f.open) * 100, 1),
    orderConv: round(div(f.orders, f.cart) * 100, 1),
    openToOrder: round(div(f.orders, f.open) * 100, 2),
    buyoutPct: f.buyoutPct != null ? round(f.buyoutPct, 0) : null,
    avgCheck: round(div(f.orderSum, f.orders), 0),
    ads: {
      views: a.views,
      clicks: a.clicks,
      atbs: a.atbs,
      orders: a.orders,
      spend: round(a.spend, 0),
      ctr: round(div(a.clicks, a.views) * 100, 2),
      cpc: round(div(a.spend, a.clicks), 1),
      cpo: round(div(a.spend, a.orders), 0),
      drr: a.spend > 0 ? round(div(a.spend, f.orderSum) * 100, 1) : null,
      orderShare: f.orders ? Math.min(100, round((a.orders / f.orders) * 100, 0)) : null,
    },
  };
}

export function latestSnapshot(db, nmId) {
  // Последнее известное значение каждого поля (цены и остатки могут прийти в разные дни)
  const fields = ['price', 'discount_pct', 'seller_price', 'club_price', 'stocks_wb', 'stocks_mp', 'product_rating', 'feedback_rating', 'delivery_hours'];
  const out = { date: null };
  for (const f of fields) {
    const r = db.prepare(`SELECT ${f} AS v, date FROM snapshot_daily WHERE nm_id = ? AND ${f} IS NOT NULL ORDER BY date DESC LIMIT 1`).get(nmId);
    out[f] = r ? r.v : null;
    if (r && (!out.date || r.date > out.date)) out.date = r.date;
  }
  return out;
}

export function feedbackStats(db, nmId, today = todayMsk()) {
  const r = db
    .prepare(`SELECT COUNT(*) total, AVG(rating) avg,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) last7,
        SUM(CASE WHEN rating <= 3 AND answered = 0 THEN 1 ELSE 0 END) negUnanswered,
        SUM(CASE WHEN answered = 0 THEN 1 ELSE 0 END) unanswered
      FROM feedbacks WHERE nm_id = ?`)
    .get(addDays(today, -7), nmId);
  return { total: r.total, avg: round(r.avg, 2), last7: r.last7 || 0, negUnanswered: r.negUnanswered || 0, unanswered: r.unanswered || 0 };
}

const pctChange = (cur, prev) => (prev ? round(((cur - prev) / prev) * 100, 0) : null);

// ---------- Тревоги по артикулу ----------
export function buildAlerts({ cur, prev, snap, stockDays, fb, unit, settings }) {
  const alerts = [];
  const add = (level, text) => alerts.push({ level, text });
  if (snap.stocks_wb === 0) add('critical', 'Нет остатков на складе WB — карточка не продаётся');
  else if (stockDays != null && stockDays < settings.minStockDays) add('warning', `Остатка хватит примерно на ${Math.round(stockDays)} дн. — пора готовить поставку`);
  if (fb.negUnanswered > 0) add('critical', `Негативных отзывов без ответа: ${fb.negUnanswered}`);
  const rating = snap.feedback_rating ?? snap.product_rating;
  if (rating != null && rating > 0 && rating < settings.minRating) add('warning', `Рейтинг ${String(rating).replace('.', ',')} — ниже цели ${String(settings.minRating).replace('.', ',')}`);
  if (cur.ads.drr != null && cur.ads.spend > 0 && cur.ads.drr > settings.targetDrrPct) add('warning', `ДРР ${cur.ads.drr}% выше цели ${settings.targetDrrPct}%`);
  if (cur.ads.spend > 0 && cur.ads.orders === 0) add('warning', `Реклама потратила ${cur.ads.spend} ₽ без заказов за 7 дней`);
  if (unit.profitPerUnit != null && unit.profitPerUnit < 0) add('critical', `Продажа в минус: ${unit.profitPerUnit} ₽ на штуку до рекламы`);
  if (unit.workAdPerSale != null && cur.ads.cpo != null && cur.ads.cpo > unit.maxAdPerSale) add('critical', `Заказ через рекламу стоит ${cur.ads.cpo} ₽ — больше всей прибыли с продажи`);
  if (cur.open >= 50 && prev.cartConv != null && cur.cartConv != null && cur.cartConv < prev.cartConv * 0.7)
    add('warning', `Конверсия в корзину упала: ${prev.cartConv}% → ${cur.cartConv}%`);
  if (cur.open >= 100 && cur.orders === 0) add('warning', 'Переходы есть, а заказов нет — проверьте цену, фото и отзывы');
  if (unit.cost == null) add('info', 'Не указана себестоимость — прибыль не считается');
  return alerts;
}

function statusOf(alerts) {
  if (alerts.some((a) => a.level === 'critical')) return 'red';
  if (alerts.some((a) => a.level === 'warning')) return 'yellow';
  return 'green';
}

// ---------- Сводка по всем товарам ----------
export function overview(db, settings, today = todayMsk()) {
  const products = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY sort, nm_id').all();
  return products.map((p) => productSummary(db, p, settings, today));
}

export function productSummary(db, p, settings, today = todayMsk()) {
  const cur = periodMetrics(db, p.nm_id, addDays(today, -6), today);
  const prev = periodMetrics(db, p.nm_id, addDays(today, -13), addDays(today, -7));
  const last14 = periodMetrics(db, p.nm_id, addDays(today, -13), today);
  const snap = latestSnapshot(db, p.nm_id);
  const fb = feedbackStats(db, p.nm_id, today);
  const actual = actualCosts(db, p.nm_id, today);
  const price = snap.seller_price ?? null;
  const cost = p.cost_per_unit ?? (settings.defaultCostPerUnit || null);
  const unit = unitEconomics({ price, cost, settings, actual: actual ? { ...actual, buyoutPct: cur.buyoutPct ?? undefined } : null });
  const ordersPerDay = last14.orders / 14;
  const stockDays = snap.stocks_wb != null && ordersPerDay > 0 ? snap.stocks_wb / ordersPerDay : null;
  const profit = unit.profitPerUnit != null ? round(cur.buyouts * unit.profitPerUnit - (cur.ads.spend || 0), 0) : null;
  const alerts = buildAlerts({ cur, prev, snap, stockDays, fb, unit, settings });
  const spark = db
    .prepare('SELECT date, order_count FROM funnel_daily WHERE nm_id = ? AND date BETWEEN ? AND ? ORDER BY date')
    .all(p.nm_id, addDays(today, -13), today);
  const byDate = Object.fromEntries(spark.map((r) => [r.date, r.order_count]));
  const plan = db.prepare("SELECT id, strategy_key, title, start_date FROM plans WHERE nm_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(p.nm_id);
  return {
    nmId: p.nm_id,
    title: p.title,
    vendorCode: p.vendor_code,
    groupName: p.group_name,
    cost: p.cost_per_unit,
    costSource: p.cost_source || null,
    snapshot: snap,
    week: cur,
    prevWeek: prev,
    changes: {
      open: pctChange(cur.open, prev.open),
      orders: pctChange(cur.orders, prev.orders),
      orderSum: pctChange(cur.orderSum, prev.orderSum),
    },
    unit,
    weekProfit: profit,
    stockDays: round(stockDays, 0),
    feedbacks: fb,
    alerts,
    status: statusOf(alerts),
    sparkOrders: dateRange(addDays(today, -13), today).map((d) => byDate[d] ?? 0),
    activePlan: plan || null,
  };
}

// ---------- Подробно по товару: ряды по дням ----------
export function productSeries(db, nmId, days = 30, today = todayMsk()) {
  const from = addDays(today, -(days - 1));
  const dates = dateRange(from, today);
  const funnel = Object.fromEntries(db.prepare('SELECT * FROM funnel_daily WHERE nm_id = ? AND date >= ?').all(nmId, from).map((r) => [r.date, r]));
  const ads = Object.fromEntries(
    db
      .prepare('SELECT date, SUM(views) views, SUM(clicks) clicks, SUM(orders) orders, SUM(spend) spend FROM ads_daily WHERE nm_id = ? AND date >= ? GROUP BY date')
      .all(nmId, from)
      .map((r) => [r.date, r]),
  );
  const snap = Object.fromEntries(db.prepare('SELECT * FROM snapshot_daily WHERE nm_id = ? AND date >= ?').all(nmId, from).map((r) => [r.date, r]));
  const search = Object.fromEntries(db.prepare('SELECT date, avg_position, visibility FROM search_daily WHERE nm_id = ? AND date >= ?').all(nmId, from).map((r) => [r.date, r]));
  return dates.map((date) => {
    const f = funnel[date] || {};
    const a = ads[date] || {};
    const s = snap[date] || {};
    const q = search[date] || {};
    return {
      date,
      open: f.open_count ?? null,
      cart: f.cart_count ?? null,
      orders: f.order_count ?? null,
      orderSum: f.order_sum ?? null,
      buyouts: f.buyout_count ?? null,
      cartConv: f.open_count ? round((f.cart_count / f.open_count) * 100, 1) : null,
      orderConv: f.cart_count ? round((f.order_count / f.cart_count) * 100, 1) : null,
      adViews: a.views ?? 0,
      adClicks: a.clicks ?? 0,
      adOrders: a.orders ?? 0,
      adSpend: round(a.spend ?? 0, 0),
      price: s.seller_price ?? null,
      stocks: s.stocks_wb ?? null,
      rating: s.feedback_rating ?? null,
      avgPosition: q.avg_position ?? null,
      visibility: q.visibility ?? null,
    };
  });
}

// ---------- Базовая линия для симулятора: средние за 14 дней ----------
export function baselineFor(db, nmId, settings, today = todayMsk()) {
  const m = periodMetrics(db, nmId, addDays(today, -13), today);
  const snap = latestSnapshot(db, nmId);
  const product = db.prepare('SELECT cost_per_unit FROM products WHERE nm_id = ?').get(nmId);
  const actual = actualCosts(db, nmId, today);
  const enough = m.open >= 50 && m.cart >= 5;
  const opensPerDay = m.open / 14;
  const adClicksPerDay = m.ads.clicks / 14;
  return {
    nmId,
    dataDays: m.days,
    enoughData: enough,
    organicOpensPerDay: round(Math.max(0, opensPerDay - adClicksPerDay), 1),
    adClicksPerDay: round(adClicksPerDay, 1),
    adSpendPerDay: round(m.ads.spend / 14, 0),
    cartConv: enough ? m.cart / m.open : 0.12,
    orderConv: enough && m.cart ? m.orders / m.cart : 0.5,
    buyoutPct: (m.buyoutPct ?? settings.defaultBuyoutPct) / 100,
    price: snap.seller_price ?? null,
    cost: product?.cost_per_unit ?? (settings.defaultCostPerUnit || null),
    actual,
    ordersPerDay: round(m.orders / 14, 2),
  };
}
