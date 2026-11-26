// Расчёт показателей: воронка за период, реклама, юнит-экономика, остатки, тревоги.
import { effectiveStatus } from './campaign-status.mjs';
import { addDays, dateRange, todayMsk } from './dates.mjs';

const round = (v, d = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const div = (a, b) => (b ? a / b : null);

// ---------- Юнит-экономика ----------
// Только реальные данные (решение Марка 25.11.2026): ни одной придуманной цифры.
//   комиссия      — финотчёт WB за 30 дней → официальный тариф WB по предмету (FBW)
//   эквайринг     — финотчёт WB (в API тарифа нет)
//   налог         — ставка Марка из «Настроек» (зависит от его системы налогообложения)
//   логистика     — финотчёт → тариф WB для коробов на складах, где лежит товар: первый литр + доп. литры × (литры − 1)
//   хранение      — финотчёт → тариф WB в день за литраж × дней до продажи (остаток ÷ продажи в день)
//   объём         — длина × ширина × высота упаковки из карточки WB ÷ 1000
//   выкуп         — аналитика WB по товару за 30 дней
// Чего нет — в расчёт не входит и перечисляется в missing; если нет себестоимости или комиссии, прибыль не считается.

/** Тариф короба по формуле WB: первый литр + доп. литр × (литры − 1). */
export function boxTariff(base, perLiter, liters) {
  if (base == null || liters == null) return null;
  return base + Math.max(0, liters - 1) * (perLiter ?? 0);
}

export function unitEconomics({ price, cost, settings, inputs = {} }) {
  const missing = [];
  const hasCost = cost != null && cost > 0;
  if (!hasCost) missing.push('себестоимость (лист «Себестоимость» в «Финансы V3»)');
  const buyoutPct = inputs.buyoutPct ?? null;
  const buyout = buyoutPct != null && buyoutPct > 0 ? buyoutPct / 100 : null;
  if (buyout == null) missing.push('процент выкупа (WB ещё не дал данных по выкупам)');

  const commissionPct = inputs.commission?.pct ?? null;
  if (commissionPct == null) missing.push('комиссия WB (нет тарифа по предмету товара)');
  const acquiringPct = inputs.acquiring?.pct ?? null;
  if (acquiringPct == null) missing.push('эквайринг (появится из финотчёта WB после первых продаж)');
  const taxPct = settings.taxPct ?? null;
  if (taxPct == null) missing.push('налог (укажите вашу ставку в «Настройках»)');

  // Логистика на проданную штуку: факт уже включает невыкупы; по тарифу — доставка ÷ доля выкупа
  let logisticsPerSold = null;
  let logisticsSource = null;
  if (inputs.fact?.logisticsPerSold != null) {
    logisticsPerSold = inputs.fact.logisticsPerSold;
    logisticsSource = `${inputs.fact.label}; доставка покупателю и возвраты от покупателей; вывоз товара вам («к продавцу») не входит${inputs.fact.logisticsPerDelivery != null ? `, медиана за одну доставку ${String(round(inputs.fact.logisticsPerDelivery, 1)).replace('.', ',')} ₽` : ''}`;
  } else if (inputs.logistics?.perDelivery != null) {
    logisticsPerSold = inputs.logistics.perDelivery / (buyout ?? 1);
    logisticsSource = inputs.logistics.source;
    if (buyout != null && buyout < 1) missing.push('обратная логистика невыкупов (тарифа нет в API WB — появится из финотчёта)');
  } else missing.push(inputs.logistics?.why || 'логистика (нет объёма упаковки или тарифа склада)');

  let storagePerSold = null;
  let storageSource = null;
  if (inputs.fact?.storagePerSold != null) {
    storagePerSold = inputs.fact.storagePerSold;
    storageSource = `${inputs.fact.label}; платное хранение и обработка товара при приёмке, в расчёте на одну продажу`;
  } else if (inputs.storage?.perDay != null && inputs.storage?.days != null) {
    storagePerSold = inputs.storage.perDay * inputs.storage.days;
    storageSource = inputs.storage.source;
  } else missing.push(inputs.storage?.why || 'хранение (нет объёма упаковки или тарифа склада)');

  const pctShare = ((commissionPct ?? 0) + (acquiringPct ?? 0) + (taxPct ?? 0)) / 100;
  const fixed = (hasCost ? cost : 0) + (logisticsPerSold ?? 0) + (storagePerSold ?? 0);
  const canProfit = price != null && hasCost && commissionPct != null;
  const profit = canProfit ? price * (1 - pctShare) - fixed : null;
  return {
    price,
    cost: hasCost ? cost : null,
    commissionPct: round(commissionPct, 1),
    commissionSource: inputs.commission?.source ?? null,
    acquiringPct: round(acquiringPct, 2),
    acquiringSource: inputs.acquiring?.source ?? null,
    taxPct,
    buyoutPct: buyoutPct != null ? round(buyoutPct, 0) : null,
    buyoutSource: inputs.buyoutSource ?? null,
    logisticsPerSold: round(logisticsPerSold, 0),
    logisticsSource,
    logisticsDetail: inputs.fact?.logisticsPerSold == null ? inputs.logistics?.detail ?? null : null,
    storagePerSold: round(storagePerSold, 0),
    storageSource,
    storageDetail: inputs.fact?.storagePerSold == null ? inputs.storage?.detail ?? null : null,
    liters: inputs.liters ?? null,
    missing,
    complete: missing.length === 0,
    pctShare,
    fixedPerUnit: fixed,
    profitPerUnit: profit != null ? round(profit, 0) : null,
    marginPct: profit != null && price ? round((profit / price) * 100, 1) : null,
    breakEvenPrice: canProfit && pctShare < 1 ? round(fixed / (1 - pctShare), 0) : null,
    maxAdPerSale: profit != null ? round(Math.max(0, profit), 0) : null,
    workAdPerSale: profit != null ? round(Math.max(0, profit - settings.targetProfitPerUnit), 0) : null,
    source: inputs.fact ? 'finance' : 'tariffs',
  };
}

/** Все реальные вводные для юнит-экономики товара: тарифы, объём, склады, факт из финотчёта, выкуп. */
export function costInputs(db, nmId, today = todayMsk()) {
  const p = db.prepare('SELECT length_cm, width_cm, height_cm FROM products WHERE nm_id = ?').get(nmId) || {};
  const liters = p.length_cm && p.width_cm && p.height_cm ? (p.length_cm * p.width_cm * p.height_cm) / 1000 : null;
  const own = actualCosts(db, nmId, today, 90, 3);
  const shop = own ? null : actualCosts(db, null, today, 90, 10);
  const fact = own || shop;
  const factLabel = own ? `финотчёт WB по товару за 90 дней (${own.soldUnits} продаж)` : shop ? `финотчёт WB, по всему магазину за 90 дней (${shop.soldUnits} продаж) — своих продаж у товара пока мало` : null;

  const tariff = tariffFor(db, nmId);
  const commission = fact?.commissionPct != null
    ? { pct: fact.commissionPct, source: `${factLabel}; фактически удержано WB${fact.commissionIncludesAcquiring ? ', включая эквайринг' : ''}` }
    : tariff?.pct != null ? { pct: tariff.pct, source: `тариф WB для предмета «${tariff.subjectName}» (FBW)` } : null;
  const acquiring = fact?.commissionIncludesAcquiring
    ? { pct: 0, source: 'уже входит в фактическую комиссию' }
    : fact?.acquiringPct != null ? { pct: fact.acquiringPct, source: factLabel } : null;

  // Склады, где лежит товар, и их тарифы (доля склада — по остатку)
  const wh = db
    .prepare(`SELECT s.warehouse, s.qty, t.delivery_base, t.delivery_liter, t.storage_base, t.storage_liter, t.tariff_date
      FROM stock_wh s JOIN box_tariffs t ON t.warehouse = s.warehouse WHERE s.nm_id = ? AND s.qty > 0`)
    .all(nmId);
  const totalQty = wh.reduce((n, w) => n + w.qty, 0);
  const weighted = (fn) => (totalQty ? wh.reduce((n, w) => n + fn(w) * w.qty, 0) / totalQty : null);
  const whText = wh.map((w) => `${w.warehouse} (${w.qty} шт.)`).join(', ');
  const tariffDate = wh[0]?.tariff_date || null;

  let logistics = null;
  let storage = null;
  if (liters == null) {
    logistics = { why: 'логистика: нет размеров упаковки в карточке WB (нужна категория токена «Контент»)' };
    storage = { why: 'хранение: нет размеров упаковки в карточке WB (нужна категория токена «Контент»)' };
  } else if (!wh.length) {
    logistics = { why: 'логистика: неизвестно, на каких складах WB лежит товар, или нет тарифов этих складов' };
    storage = { why: 'хранение: неизвестно, на каких складах WB лежит товар, или нет тарифов этих складов' };
  } else {
    const perDelivery = weighted((w) => boxTariff(w.delivery_base, w.delivery_liter, liters) ?? 0);
    const perDay = weighted((w) => boxTariff(w.storage_base, w.storage_liter, liters) ?? 0);
    logistics = {
      perDelivery,
      source: `тариф WB для коробов на ${tariffDate}`,
      detail: `объём ${String(round(liters, 3)).replace('.', ',')} л; склады: ${whText}; за доставку ${String(round(perDelivery, 2)).replace('.', ',')} ₽`,
    };
    // Сколько дней штука лежит до продажи: остаток ÷ продажи в день (заказы за 14 дней × выкуп)
    const m = periodMetrics(db, nmId, addDays(today, -13), today);
    const snap = latestSnapshot(db, nmId);
    const buyout = m.buyoutPct > 0 ? m.buyoutPct / 100 : 1;
    const salesPerDay = (m.orders / 14) * buyout;
    const days = snap.stocks_wb != null && salesPerDay > 0 ? snap.stocks_wb / salesPerDay : null;
    storage = {
      perDay,
      days: days != null ? Math.min(days, 365) : null,
      source: `тариф WB для коробов на ${tariffDate} × дней до продажи`,
      detail: `${String(round(perDay, 3)).replace('.', ',')} ₽ в день × ${days != null ? `${Math.round(Math.min(days, 365))} дн. (остаток ${snap.stocks_wb} шт. ÷ ${String(round(salesPerDay, 2)).replace('.', ',')} продаж в день)` : '— дн.'}`,
      why: days == null ? 'хранение на штуку: нет продаж за 14 дней — не из чего посчитать, сколько дней товар пролежит' : undefined,
    };
  }
  const m30 = periodMetrics(db, nmId, addDays(today, -29), today);
  // Выкуп: аналитика WB (если уже есть выкупы) → финотчёт товара → финотчёт магазина. 0% у нового товара — «выкупов ещё нет», а не «никто не выкупает».
  const ownFin = own?.buyoutPct != null ? own : actualCosts(db, nmId, today, 90, 1);
  const shopFin = shop || actualCosts(db, null, today, 90, 10);
  const buyoutPick = m30.buyoutPct > 0 ? { pct: m30.buyoutPct, source: 'аналитика WB за 30 дней' }
    : ownFin?.buyoutPct != null ? { pct: ownFin.buyoutPct, source: `финотчёт WB по товару: продано ÷ доставлено (${ownFin.deliveries} доставок)` }
    : shopFin?.buyoutPct != null ? { pct: shopFin.buyoutPct, source: `финотчёт WB по всему магазину: продано ÷ доставлено (${shopFin.deliveries} доставок) — у товара ещё нет выкупов` }
    : null;
  return {
    liters: liters != null ? round(liters, 3) : null,
    commission,
    acquiring,
    logistics,
    storage,
    fact: fact ? { logisticsPerSold: fact.logisticsPerSold, storagePerSold: fact.storagePerSold + fact.acceptancePerSold, label: factLabel, logisticsPerDelivery: fact.logisticsPerDelivery } : null,
    buyoutPct: buyoutPick?.pct ?? null,
    buyoutSource: buyoutPick?.source ?? null,
  };
}

// Официальная комиссия WB по предмету товара (FBW). Если предмет неизвестен, а у всех товаров он один — берём его.
export function tariffFor(db, nmId) {
  const own = db.prepare('SELECT t.fbw_pct pct, t.subject_name subjectName FROM products p JOIN subject_tariffs t ON t.subject_id = p.subject_id WHERE p.nm_id = ?').get(nmId);
  if (own?.pct != null) return own;
  const all = db.prepare('SELECT DISTINCT t.fbw_pct pct, t.subject_name subjectName FROM products p JOIN subject_tariffs t ON t.subject_id = p.subject_id WHERE p.subject_id IS NOT NULL').all();
  return all.length === 1 && all[0].pct != null ? all[0] : null;
}

// Фактические расходы из финотчёта WB (детализация). nmId = null — по всему магазину.
//   комиссия — фактическая: 1 − «к перечислению» ÷ «цена с учётом скидки» по продажам (в неё уже входит эквайринг и скидки WB);
//   логистика на проданную штуку — все «услуги по доставке» (туда и обратно) ÷ чистые продажи;
//   логистика за одну доставку — медиана по строкам «Логистика» (услуги ÷ количество доставок);
//   хранение и приёмка — суммы ÷ чистые продажи.
// В логистику продажи идут только доставки покупателю и обратно («К клиенту…», «От клиента…», коррекции).
// Доставки «К продавцу» / «От продавца» (вывоз товара со склада вам, возврат неопознанного товара) — разовые
// расходы, не на каждую продажу: 30.09.2026 WB вернул 595 шт. «неопознанного товара» по 255 ₽ = 151 725 ₽.
// Строки с логистикой больше чем в 20 раз выше медианы тоже не учитываются.
const median = (arr) => {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

export function actualCosts(db, nmId, today = todayMsk(), days = 90, minSold = 3) {
  const from = addDays(today, -days);
  const where = nmId == null ? 'date >= ?' : 'nm_id = ? AND date >= ?';
  const args = nmId == null ? [from] : [nmId, from];
  const lines = db.prepare(`SELECT oper_name, bonus_type, quantity, retail_price_disc, for_pay, commission_pct, delivery, delivery_amount, return_amount, storage, acceptance, penalty, deduction, acquiring
    FROM finance_lines WHERE ${where}`).all(...args);
  if (!lines.length) return null;
  const isSale = (l) => /^Продажа/.test(l.oper_name || '');
  const isReturn = (l) => /^Возврат/.test(l.oper_name || '');
  const sold = lines.filter(isSale).reduce((n, l) => n + (l.quantity || 0), 0);
  const returned = lines.filter(isReturn).reduce((n, l) => n + (l.quantity || 0), 0);
  const net = sold - returned;
  if (net < minSold) return null; // мало продаж — оценка ненадёжна
  const toSeller = (l) => /продавц/i.test(l.bonus_type || '');
  const perDelivery = lines
    .filter((l) => !toSeller(l) && (l.delivery || 0) > 0 && (l.delivery_amount || 0) + (l.return_amount || 0) > 0)
    .map((l) => l.delivery / ((l.delivery_amount || 0) + (l.return_amount || 0)));
  const deliveryMedian = median(perDelivery);
  const isOutlier = (l) => deliveryMedian != null && (l.delivery || 0) > 0 && (l.delivery / Math.max(1, (l.delivery_amount || 0) + (l.return_amount || 0))) > deliveryMedian * 20;
  const outliers = lines.filter(isOutlier);
  const sum = (key, filter = () => true) => lines.filter(filter).reduce((n, l) => n + (l[key] || 0), 0);
  const saleRetail = sum('retail_price_disc', isSale);
  const saleForPay = sum('for_pay', isSale);
  const delivery = sum('delivery', (l) => !isOutlier(l) && !toSeller(l));
  const deliveries = sum('delivery_amount', (l) => !toSeller(l));
  const toSellerSum = sum('delivery', toSeller);
  return {
    soldUnits: net,
    days,
    // Выкуп по финотчёту: продано ÷ доставлено покупателям (нужно хотя бы 5 доставок)
    buyoutPct: deliveries >= 5 ? Math.min(100, (sold / deliveries) * 100) : null,
    deliveries,
    // Фактическая комиссия WB: сколько от цены продажи не дошло до вас (включая эквайринг)
    commissionPct: saleRetail > 0 && saleForPay > 0 ? (1 - saleForPay / saleRetail) * 100 : median(lines.filter(isSale).map((l) => l.commission_pct).filter((x) => x > 0)),
    commissionIncludesAcquiring: saleRetail > 0 && saleForPay > 0,
    acquiringPct: saleRetail > 0 ? (sum('acquiring', isSale) / saleRetail) * 100 : null,
    logisticsPerSold: delivery / net,
    logisticsPerDelivery: deliveryMedian,
    storagePerSold: sum('storage') / net,
    acceptancePerSold: sum('acceptance') / net,
    storageTotal: sum('storage'),
    penalties: sum('penalty') + sum('deduction'),
    toSellerSum,
    outliers: outliers.length,
    outlierSum: outliers.reduce((n, l) => n + (l.delivery || 0), 0),
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
  const cost = p.cost_per_unit ?? null;
  const unit = unitEconomics({ price, cost, settings, inputs: costInputs(db, p.nm_id, today) });
  const ordersPerDay = last14.orders / 14;
  const stockDays = snap.stocks_wb != null && ordersPerDay > 0 ? snap.stocks_wb / ordersPerDay : null;
  // Ожидаемая прибыль за 7 дней: заказы × доля выкупа × прибыль с продажи − реклама.
  // Не по выкупам: WB засчитывает выкуп через несколько дней после заказа, и свежие заказы давали бы «минус весь расход».
  // Выкуп неизвестен — считаем, что выкупают всё, и это видно в «missing»
  const profit = unit.profitPerUnit != null ? round(cur.orders * ((unit.buyoutPct ?? 100) / 100) * unit.profitPerUnit - (cur.ads.spend || 0), 0) : null;
  // Маржа: сколько заработали на заказах до рекламы (цена − все удержания − себестоимость) и какую долю съела реклама
  const marginWeek = unit.profitPerUnit != null ? round(cur.orders * ((unit.buyoutPct ?? 100) / 100) * unit.profitPerUnit, 0) : null;
  const adShareOfMarginPct = marginWeek > 0 && cur.ads.spend > 0 ? round((cur.ads.spend / marginWeek) * 100, 0) : null;
  const alerts = buildAlerts({ cur, prev, snap, stockDays, fb, unit, settings });
  const spark = db
    .prepare('SELECT date, order_count FROM funnel_daily WHERE nm_id = ? AND date BETWEEN ? AND ? ORDER BY date')
    .all(p.nm_id, addDays(today, -13), today);
  const byDate = Object.fromEntries(spark.map((r) => [r.date, r.order_count]));
  const plan = db.prepare("SELECT id, strategy_key, title, start_date FROM plans WHERE nm_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(p.nm_id);
  // Действующая реклама на товаре (для отметки в сводке)
  const ads = db
    .prepare("SELECT advert_id, name, status, payment_type, bids_json, budget_spent_at FROM campaigns WHERE status IN (4, 9, 11) AND EXISTS (SELECT 1 FROM json_each(campaigns.nm_ids) WHERE value = ?)")
    .all(p.nm_id)
    .map((c) => ({ ...c, status: effectiveStatus(c, db).status }))
    .map((c) => {
      const bids = (() => { try { return JSON.parse(c.bids_json || '{}')[p.nm_id] || {}; } catch { return {}; } })();
      return { advertId: c.advert_id, name: c.name, status: c.status, paymentType: c.payment_type, bid: bids.search ?? bids.recommendations ?? null };
    });
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
    weekMargin: marginWeek,
    adShareOfMarginPct,
    profitPerOrder: unit.profitPerUnit != null ? round(unit.profitPerUnit * ((unit.buyoutPct ?? 100) / 100), 0) : null,
    stockDays: round(stockDays, 0),
    feedbacks: fb,
    alerts,
    status: statusOf(alerts),
    sparkOrders: dateRange(addDays(today, -13), today).map((d) => byDate[d] ?? 0),
    activePlan: plan || null,
    campaigns: ads,
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
  const tariff = tariffFor(db, nmId);
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
    ...(() => {
      const ci = costInputs(db, nmId, today);
      return { costInputs: ci, buyoutPct: ci.buyoutPct != null ? ci.buyoutPct / 100 : 1, buyoutKnown: ci.buyoutPct != null };
    })(),
    price: snap.seller_price ?? null,
    cost: product?.cost_per_unit ?? null,
    actual,
    tariff,
    ordersPerDay: round(m.orders / 14, 2),
  };
}
