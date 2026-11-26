// Экономика рекламы WB по каждой кампании и товару: прогноз при запуске, факт, сравнение и советы.
//
// Формулы (всё в рублях, конверсия — доля от 0 до 1):
//   прибыль с продажи до рекламы  = юнит-экономика (цена × (1 − комиссия − эквайринг − налог) − себестоимость − логистика − хранение)
//   прибыль с заказа до рекламы   = прибыль с продажи × доля выкупа
//   цена клика (CPC)              = ставка за клик × доля списания; для оплаты за показы = ставка за 1000 показов × доля списания / 1000 / CTR
//                                   (аукцион второй цены: WB списывает не больше ставки, обычно меньше; доля — по факту кампании)
//   стоимость заказа с рекламы    = CPC / конверсия клика в заказ
//   ДРР                           = CPC / (конверсия × цена)
//   безубыточная ставка           = прибыль с заказа × конверсия
//   ставка под цель по ДРР        = цель ДРР × цена × конверсия
// Объём (сколько кликов в день) — оценка: по факту кампании или по бюджету. Такие значения помечены как допущения.
import { addDays, todayMsk } from './dates.mjs';
import { nowIso } from './db.mjs';
import { periodMetrics, productSummary } from './metrics.mjs';
import { LIVE_STATUSES } from './wb/collect.mjs';
import { effectiveStatus } from './campaign-status.mjs';
import { decayedRate, wilson } from './stats.mjs';

const round = (v, d = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const div = (a, b) => (b ? a / b : null);
const parse = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

export const PAYMENT_LABEL = { cpc: 'оплата за клик', cpm: 'оплата за 1000 показов' };
const MIN_CLICKS_FOR_CR = 100; // меньше — конверсия рекламы ещё случайна
const MIN_VIEWS_FOR_CTR = 1000;
const VOLUME_ELASTICITY = 0.7; // допущение: ставка ×2 даёт кликов примерно ×1,6

// ---------- Чистые расчёты (проверяются тестами) ----------

/** Цена клика: за клик — ставка × доля списания; за показы — ставка за 1000 показов × доля / 1000 / CTR. */
export function effectiveCpc({ paymentType, bid, ctr, chargeRatio = 1 }) {
  if (bid == null) return null;
  const charged = bid * (chargeRatio ?? 1);
  if (paymentType === 'cpm') return ctr ? charged / 1000 / ctr : null;
  return charged;
}

/** Ставка, при которой цена клика будет равна заданной (обратный пересчёт). */
export function bidForCpc({ paymentType, ctr, chargeRatio = 1 }, cpc) {
  if (cpc == null) return null;
  const ratio = chargeRatio || 1;
  if (paymentType === 'cpm') return ctr ? (cpc * ctr * 1000) / ratio : null;
  return cpc / ratio;
}

/**
 * Экономика при заданных вводных. Возвращает «на клик/заказ» (точные формулы) и «в день» (оценка объёма).
 * inputs: { paymentType, bid, ctr, cr, price, profitPerUnit, buyoutPct, targetDrrPct, clicksPerDay }
 */
export function adEconomics(inputs) {
  const { price, profitPerUnit, cr } = inputs;
  // Выкуп неизвестен — без учёта невыкупов (100%); это видно в юнит-экономике как «нет данных»
  const buyout = (inputs.buyoutPct ?? 100) / 100;
  const cpc = effectiveCpc(inputs);
  const profitPerOrder = profitPerUnit != null ? profitPerUnit * buyout : null;
  const costPerOrder = cpc != null && cr ? cpc / cr : null;
  const drrPct = cpc != null && cr && price ? (cpc / (cr * price)) * 100 : null;
  const profitPerOrderAfterAds = profitPerOrder != null && costPerOrder != null ? profitPerOrder - costPerOrder : null;
  // Прибыль с одного клика = конверсия × маржа с заказа − цена клика. Работает и при нулевой конверсии (тогда = −цена клика).
  const profitPerClick = profitPerOrder != null && cr != null && cpc != null ? cr * profitPerOrder - cpc : null;
  const breakEvenCpc = profitPerOrder != null && cr ? Math.max(0, profitPerOrder * cr) : null;
  const targetCpc = inputs.targetDrrPct != null && price && cr ? (inputs.targetDrrPct / 100) * price * cr : null;
  const clicks = inputs.clicksPerDay ?? null;
  const perDay = clicks != null && cpc != null && cr != null
    ? {
        views: inputs.paymentType === 'cpm' || inputs.ctr ? round(div(clicks, inputs.ctr ?? null), 0) : null,
        clicks: round(clicks, 1),
        orders: round(clicks * cr, 2),
        buyouts: round(clicks * cr * buyout, 2),
        spend: round(clicks * cpc, 0),
        revenue: price ? round(clicks * cr * price, 0) : null,
        profit: profitPerClick != null ? round(clicks * profitPerClick, 0) : null,
      }
    : null;
  return {
    cpc: round(cpc, 2),
    cr: cr != null ? round(cr * 100, 2) : null,
    profitPerOrder: round(profitPerOrder, 0),
    costPerOrder: round(costPerOrder, 0),
    drrPct: round(drrPct, 1),
    breakEvenDrrPct: profitPerOrder != null && price ? round((profitPerOrder / price) * 100, 1) : null,
    profitPerOrderAfterAds: round(profitPerOrderAfterAds, 0),
    profitPerClick: round(profitPerClick, 2),
    profitPer100Clicks: profitPerClick != null ? round(profitPerClick * 100, 0) : null,
    marginAfterAdsPct: profitPerOrderAfterAds != null && price ? round((profitPerOrderAfterAds / price) * 100, 1) : null,
    // Какую долю маржи (прибыли с заказа до рекламы) съедает реклама: 100% — работаете в ноль
    adShareOfMarginPct: costPerOrder != null && profitPerOrder > 0 ? round((costPerOrder / profitPerOrder) * 100, 0) : null,
    breakEvenCpc: round(breakEvenCpc, 2),
    targetCpc: round(targetCpc, 2),
    // Какую ставку ставить в кабинете. Считаем, что WB спишет всю ставку: доля списания (аукцион второй цены)
    // известна только для нынешней ставки, при другой ставке она может быть любой — но никогда больше ставки.
    // Так совет «до N ₽» гарантированно не уводит в минус, а фактическое списание ниже — ваш запас.
    breakEvenBid: round(bidForCpc({ ...inputs, chargeRatio: 1 }, breakEvenCpc), inputs.paymentType === 'cpm' ? 0 : 1),
    targetBid: round(bidForCpc({ ...inputs, chargeRatio: 1 }, targetCpc), inputs.paymentType === 'cpm' ? 0 : 1),
    perDay,
  };
}

/**
 * Сценарии «что будет при другой ставке». Клики при новой ставке — допущение:
 * растут медленнее ставки (ставка ×2 → клики ≈ ×1,6) и не больше, чем позволяет дневной бюджет.
 */
export function bidScenarios(inputs, { extraBids = [] } = {}) {
  const base = inputs.bid;
  if (!base) return [];
  const factors = [0.6, 0.8, 1, 1.25, 1.5, 2];
  const bids = [...factors.map((f) => base * f), ...extraBids.filter((b) => b > 0)];
  const uniq = [...new Set(bids.map((b) => round(b, inputs.paymentType === 'cpm' ? 0 : 1)))].sort((a, b) => a - b);
  return uniq.map((bid) => {
    let clicksPerDay = inputs.clicksPerDay != null ? inputs.clicksPerDay * (bid / base) ** VOLUME_ELASTICITY : null;
    const cpc = effectiveCpc({ ...inputs, bid });
    if (clicksPerDay != null && inputs.dailyBudget && cpc) clicksPerDay = Math.min(clicksPerDay, inputs.dailyBudget / cpc);
    const e = adEconomics({ ...inputs, bid, clicksPerDay });
    return { bid, current: Math.abs(bid - base) < 1e-9, ...e };
  });
}

/**
 * Факт по кампании и товару за период по дням из ads_daily.
 * ДРР считаем двумя способами: drrPct — от вашей цены продажи (так же, как прогноз; на нём советы),
 * drrWbPct — от суммы заказов в ценах покупателя (так показывает кабинет WB, обычно ниже из-за скидки WB).
 */
export function adFact(db, advertId, nmId, from, to, price = null, { withOthers = false } = {}) {
  // withOthers: кампания на одном товаре — добавляем корзины и заказы других ваших товаров после клика по рекламе
  // (WB учитывает их в статистике кампании, так же в его отчёте «Созданные заказы»)
  const r = db
    .prepare(`SELECT COUNT(DISTINCT CASE WHEN nm_id = ? THEN date END) days,
        COALESCE(SUM(views),0) views, COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(atbs),0) atbs,
        COALESCE(SUM(orders),0) orders, COALESCE(SUM(spend),0) spend, COALESCE(SUM(order_sum),0) orderSum, MIN(date) first, MAX(date) last,
        COALESCE(SUM(CASE WHEN nm_id <> ? THEN orders END),0) otherOrders, COALESCE(SUM(CASE WHEN nm_id <> ? THEN order_sum END),0) otherOrderSum
      FROM ads_daily WHERE advert_id = ? AND (nm_id = ? OR ?) AND date BETWEEN ? AND ?`)
    .get(nmId, nmId, nmId, advertId, nmId, withOthers ? 1 : 0, from, to);
  const ownOrders = r.orders - r.otherOrders;
  const ownSum = r.orderSum - r.otherOrderSum;
  // Выручка заказов в ценах продавца: свои — по вашей цене, чужие — по сумме из WB
  const sellerRevenue = price ? ownOrders * price + r.otherOrderSum : null;
  return {
    from,
    to,
    days: r.days,
    first: r.first,
    last: r.last,
    views: r.views,
    clicks: r.clicks,
    atbs: r.atbs,
    orders: r.orders,
    ownOrders,
    otherOrders: r.otherOrders,
    otherOrderSum: round(r.otherOrderSum, 0),
    ownOrderSum: round(ownSum, 0),
    spend: round(r.spend, 0),
    orderSum: round(r.orderSum, 0),
    ctr: round(div(r.clicks, r.views) * 100, 2),
    cpc: round(div(r.spend, r.clicks), 2),
    cpm: round(div(r.spend, r.views) * 1000, 0),
    roas: r.spend > 0 ? round(r.orderSum / r.spend, 2) : null,
    cartRate: round(div(r.atbs, r.clicks) * 100, 1),
    cr: round(div(r.orders, r.clicks) * 100, 2),
    costPerOrder: round(div(r.spend, r.orders), 0),
    drrPct: r.spend > 0 && r.orders > 0 && sellerRevenue ? round((r.spend / sellerRevenue) * 100, 1) : null,
    drrWbPct: r.spend > 0 && r.orderSum > 0 ? round((r.spend / r.orderSum) * 100, 1) : null,
    perDay: r.days
      ? { views: round(r.views / r.days, 0), clicks: round(r.clicks / r.days, 1), orders: round(r.orders / r.days, 2), spend: round(r.spend / r.days, 0) }
      : null,
  };
}

/** Сравнение прогноза с фактом (в среднем за день). */
export function compareForecast(forecast, fact) {
  if (!forecast?.perDay || !fact?.perDay || !fact.days) return null;
  const f = forecast.perDay;
  const row = (key, label, plan, real, unit, better) => ({
    key,
    label,
    plan,
    fact: real,
    unit,
    deltaPct: plan ? round(((real - plan) / plan) * 100, 0) : null,
    good: plan == null || real == null ? null : better === 'up' ? real >= plan * 0.9 : real <= plan * 1.1,
  });
  return [
    row('clicks', 'Клики в день', f.clicks, fact.perDay.clicks, '', 'up'),
    row('orders', 'Заказы с рекламы в день', f.orders, fact.perDay.orders, '', 'up'),
    row('spend', 'Расход в день', f.spend, fact.perDay.spend, '₽', 'down'),
    row('cr', 'Конверсия клика в заказ', forecast.cr, fact.cr, '%', 'up'),
    row('cpc', 'Цена клика', forecast.cpc, fact.cpc, '₽', 'down'),
    row('drr', 'ДРР', forecast.drrPct, fact.drrPct, '%', 'down'),
  ];
}

/** Советы с числами: что сделать по кампании. */
export function adRecommendations({ econ, range = null, fact, inputs, recommended, organicCr, stockDays, settings }) {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  const r1 = (v) => (v == null ? '—' : String(round(v, 1)).replace('.', ','));
  const money = (v) => (v == null ? '—' : `${Math.round(v).toLocaleString('ru-RU')} ₽`);
  const bidLabel = inputs.paymentType === 'cpm' ? 'ставку за 1000 показов' : 'ставку за клик';
  const bidFmt = (v) => (inputs.paymentType === 'cpm' ? money(v) : `${r1(v)} ₽`);

  if (inputs.profitPerUnit == null) add('critical', 'Нет себестоимости — прибыль и безубыточная ставка не считаются. Укажите её в Менеджменте → «Товары и остатки».');
  if (inputs.status === 11) add('warning', 'По данным WB кампания на паузе: показов нет, пока её не возобновят. Если в кабинете она активна, статус обновится при следующем сборе. WB ставит на паузу сам, когда кончается бюджет или срабатывает дневной лимит.');
  if (inputs.status === 4) add('info', 'Кампания готова к запуску, но не запущена: показов нет. После запуска первый факт появится при ближайшем сборе.');

  const clicks = fact?.clicks ?? 0;
  if (inputs.status !== 4 && clicks < MIN_CLICKS_FOR_CR) {
    const perDay = fact?.perDay?.clicks;
    const daysLeft = perDay ? Math.ceil((MIN_CLICKS_FOR_CR - clicks) / perDay) : null;
    add('info', `Пока ${clicks} кликов — конверсия рекламы ещё случайна. Надёжные выводы — примерно после ${MIN_CLICKS_FOR_CR} кликов${daysLeft ? ` (ещё ~${daysLeft} дн. при текущем темпе)` : ''}. До этого расчёт идёт по конверсии ${inputs.crSource}.`);
  }
  const enough = clicks >= MIN_CLICKS_FOR_CR;
  if (enough && fact.orders === 0) {
    add('critical', `${clicks} кликов и ни одного заказа, потрачено ${money(fact.spend)}. Остановите кампанию или снизьте ставку и проверьте карточку: цену, фото, отзывы и по каким запросам идут показы.`);
  }
  // Решение по диапазону (как в системах управления ставками): сравниваем цену клика с безубыточной
  // в худшем и лучшем варианте. Пересчитывается при каждом сборе, по свежим данным.
  const g = range && range.pess ? range : null;
  if (g && econ.profitPerOrder != null && econ.cpc != null) {
    const safe = g.pess.breakEvenBid;
    const beCr = econ.profitPerOrder > 0 ? econ.cpc / econ.profitPerOrder : null; // конверсия, нужная для работы в ноль
    const budgetLimited = inputs.dailyBudget && fact?.perDay && fact.perDay.spend >= inputs.dailyBudget * 0.9;
    const step = 100;
    const more = (e) => (e?.profitPerClick != null ? (step / econ.cpc) * e.profitPerClick : null);
    const pc = (e) => e?.profitPerClick;
    if (pc(g.opt) != null && pc(g.opt) < 0) {
      add('critical', `Реклама в минус даже в лучшем варианте: при цене клика ${r1(econ.cpc)} ₽ нужна конверсия не ниже ${beCr != null ? r1(beCr * 100) : '—'}%, а у кампании она, по данным, не выше ${r1(inputs.crHigh * 100)}%. Каждые 100 кликов — от ${money(g.pess.profitPer100Clicks)} до ${money(g.opt.profitPer100Clicks)}. Снизьте ${bidLabel}${safe != null ? ` до ${bidFmt(safe)}` : ''} или остановите кампанию и проверьте карточку.`);
    } else if (pc(g.pess) != null && pc(g.pess) > 0) {
      let t = `Реклама в плюс даже в худшем варианте: каждые 100 кликов приносят от ${money(g.pess.profitPer100Clicks)} до ${money(g.opt.profitPer100Clicks)} прибыли после рекламы.`;
      if (budgetLimited) t += ` Дневной бюджет (${money(inputs.dailyBudget)}) уходит полностью — его можно поднять: каждые +${step} ₽ в день ≈ +${Math.round(step / econ.cpc)} кликов и +${money(more(g.pess))}…${money(more(g.opt))} прибыли в день (если WB продаст столько кликов — это видно по факту через 1–2 дня).`;
      if (safe != null && inputs.bid != null && inputs.bid < safe * 0.9) t += ` ${bidLabel[0].toUpperCase()}${bidLabel.slice(1)} можно поднять до ${bidFmt(safe)} — это безопасно даже при худшей конверсии; показов станет больше.`;
      add('good', t);
    } else if (pc(econ) != null && pc(econ) > 0) {
      const p = inputs.cr;
      const need = beCr != null && p > beCr ? Math.ceil((1.645 ** 2 * p * (1 - p)) / ((p - beCr) ** 2)) : null;
      add('info', `Скорее в плюс: при ожидаемой конверсии ${r1(p * 100)}% каждые 100 кликов дают ${money(econ.profitPer100Clicks)}, но не наверняка — в худшем варианте ${money(g.pess.profitPer100Clicks)}. Чтобы не рисковать — ${bidLabel} не выше ${bidFmt(safe)}.${need && need > clicks ? ` Ясно станет примерно после ${need} кликов (сейчас ${clicks}).` : ''}`);
    } else if (pc(econ) != null) {
      const p = inputs.cr;
      const need = beCr != null && p < beCr ? Math.ceil((1.645 ** 2 * beCr * (1 - beCr)) / ((beCr - p) ** 2)) : null;
      add('warning', `Скорее в минус: чтобы реклама окупалась при цене клика ${r1(econ.cpc)} ₽, нужна конверсия от ${beCr != null ? r1(beCr * 100) : '—'}%, а сейчас ожидается ${r1(p * 100)}%. Каждые 100 кликов: от ${money(g.pess.profitPer100Clicks)} до ${money(g.opt.profitPer100Clicks)}.${safe ? ` Безопасная ставка — ${bidFmt(safe)}.` : ' Безопасной ставки нет: в худшем варианте заказов может не быть совсем.'}${need && need > clicks ? ` Проверка: если к ${need} кликам конверсия не дойдёт до ${r1(beCr * 100)}%, кампанию лучше остановить (сейчас ${clicks} кликов).` : ''}`);
    }
  }
  if (fact && fact.views >= MIN_VIEWS_FOR_CTR && fact.ctr != null && fact.ctr < 1.5) {
    add('warning', `CTR ${r1(fact.ctr)}% — карточку редко выбирают из выдачи. Ставка тут не поможет: сначала главное фото, название и цена.`);
  }
  if (enough && organicCr && fact.cr != null && fact.cr < organicCr * 100 * 0.5) {
    add('warning', `С рекламы заказывают в ${r1((organicCr * 100) / fact.cr)} раза реже, чем с обычных переходов (${r1(fact.cr)}% против ${r1(organicCr * 100)}%). Проверьте, по каким запросам показывается реклама, и добавьте нерелевантные в минус-фразы.`);
  }
  const rec = recommended || null;
  if (rec?.competitive && inputs.bid != null && inputs.bid < rec.competitive * 0.8) {
    add('info', `Ставка ${bidFmt(inputs.bid)} ниже конкурентной по оценке WB (${bidFmt(rec.competitive)}) — показов будет мало.${econ.breakEvenBid != null && rec.competitive > econ.breakEvenBid ? ` Но конкурентная ставка выше безубыточной (${bidFmt(econ.breakEvenBid)}) — поднимать её невыгодно, пока не вырастет конверсия или цена.` : ''}`);
  }
  if (stockDays != null && stockDays < (settings.minStockDays ?? 14)) {
    add('warning', `Остатка на складах WB хватит примерно на ${Math.round(stockDays)} дн. Реклама ускорит продажи — подготовьте поставку, иначе карточка выпадет из выдачи.`);
  }
  if (!out.some((x) => x.level !== 'info') && enough) add('good', 'Показатели в пределах прогноза — оставьте настройки и проверьте через неделю.');
  return out;
}

// ---------- Работа с базой ----------

export function listCampaigns(db, { withFinishedDays = 30, today = todayMsk() } = {}) {
  const since = addDays(today, -withFinishedDays);
  return db
    .prepare(`SELECT * FROM campaigns WHERE status IN (${LIVE_STATUSES.join(',')}) OR (status = 7 AND substr(COALESCE(updated_at, ''), 1, 10) >= ?)
      ORDER BY CASE status WHEN 9 THEN 0 WHEN 11 THEN 1 WHEN 4 THEN 2 ELSE 3 END, advert_id DESC`)
    .all(since)
    .map((c) => ({ c, st: effectiveStatus(c, db) }))
    .map(({ c, st }) => ({
      advertId: c.advert_id,
      name: c.name,
      status: st.status,
      apiStatus: st.apiStatus,
      statusByFact: st.byFact,
      statusLabel: st.label,
      paymentType: c.payment_type,
      paymentLabel: PAYMENT_LABEL[c.payment_type] || c.payment_type || '—',
      nmIds: parse(c.nm_ids, []),
      bids: parse(c.bids_json, {}),
      placements: parse(c.placements_json, null),
      createdAt: c.created_at,
      startedAt: c.started_at,
      budgetTotal: c.budget_total,
      dailyLimit: c.daily_limit,
      spentToday: c.spent_today,
      recommended: parse(c.recommended_json, {}),
    }));
}

const startDay = (c, today) => (c.startedAt ? String(c.startedAt).slice(0, 10) : c.createdAt ? String(c.createdAt).slice(0, 10) : addDays(today, -6));

/**
 * Вводные для расчёта по кампании и товару: цена, прибыль с продажи, выкуп, конверсия и CTR (факт или допущение),
 * ставка, бюджет в день и ожидаемые клики в день.
 */
export function adInputs(db, settings, campaign, nmId, today = todayMsk(), overrides = {}) {
  const product = db.prepare('SELECT * FROM products WHERE nm_id = ?').get(nmId) || { nm_id: nmId };
  const summary = productSummary(db, product, settings, today);
  const from = startDay(campaign, today);
  const price = summary.snapshot.seller_price ?? null;
  const withOthers = (campaign.nmIds || []).length <= 1;
  const fact = adFact(db, campaign.advertId, nmId, from, today, price, { withOthers });
  const organic = periodMetrics(db, nmId, addDays(today, -29), today);
  const organicCr = organic.open >= 100 ? organic.orders / organic.open : null;

  // Конверсия клика в заказ — подстраивается под спрос: свежие дни рекламы весят больше (полураспад 7 дней),
  // а пока кликов мало, оценку поддерживает конверсия самой карточки за 30 дней (как будто 50 кликов).
  const daily = db
    .prepare(`SELECT date, SUM(clicks) clicks, SUM(orders) orders FROM ads_daily WHERE advert_id = ? AND (nm_id = ? OR ?) AND date BETWEEN ? AND ? GROUP BY date`)
    .all(campaign.advertId, nmId, withOthers ? 1 : 0, from, today);
  // Априорная конверсия — только НЕрекламные переходы карточки: из переходов и заказов карточки вычитаем рекламные
  // клики и заказы этого товара за те же 30 дней, иначе одни и те же клики посчитались бы дважды.
  const adOwn = db.prepare('SELECT COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(orders),0) orders FROM ads_daily WHERE nm_id = ? AND date BETWEEN ? AND ?').get(nmId, addDays(today, -29), today);
  const orgOpens = Math.max(0, organic.open - adOwn.clicks);
  const orgOrders = Math.max(0, organic.orders - adOwn.orders);
  const priorCr = orgOpens >= 50 ? orgOrders / orgOpens : null;
  const est = decayedRate(daily, today, { prior: priorCr });
  let cr = est ? est.rate : null;
  let crLow = est ? est.low : null;
  let crHigh = est ? est.high : null;
  const pctTxt = (v) => String(round(v * 100, 1)).replace('.', ',');
  let crSource;
  if (!est) crSource = 'нет данных: у кампании ещё нет кликов, а у карточки меньше 50 переходов без рекламы за 30 дней';
  else if (est.clicks === 0) crSource = `пока только конверсия карточки без рекламы за 30 дней: ${orgOrders} заказов из ${orgOpens} переходов`;
  else {
    crSource = `реклама: ${est.orders} заказов из ${est.clicks} кликов${fact.otherOrders ? ` (из них ${fact.otherOrders} — другие ваши товары)` : ''}, свежие дни весомее`;
    if (est.priorUsed) crSource += `; плюс конверсия карточки без рекламы ${pctTxt(priorCr)}% (${orgOrders} из ${orgOpens} переходов) с весом 50 кликов${est.clicks < 300 ? ' — пока своих кликов мало, она не даёт оценке прыгать' : ''}`;
    if (est.clicks < MIN_CLICKS_FOR_CR) crSource += ' — данных мало, диапазон широкий';
  }
  let ctr;
  let ctrSource;
  if (fact.views >= MIN_VIEWS_FOR_CTR) {
    ctr = fact.clicks / fact.views;
    ctrSource = 'факт рекламы';
  } else if (fact.views > 0) {
    ctr = fact.clicks / fact.views;
    ctrSource = `факт рекламы, но показов мало (${fact.views})`;
  } else {
    ctr = null;
    ctrSource = 'нет данных: у кампании ещё нет показов';
  }
  const bids = campaign.bids?.[nmId] || {};
  const bid = bids.search ?? bids.recommendations ?? null;
  // Аукцион второй цены: сколько WB реально списывает от ставки (по факту кампании)
  let chargeRatio = 1;
  let chargeSource = 'пока нет факта — считаем по полной ставке';
  if (bid && campaign.paymentType === 'cpm' && fact.views >= 200 && fact.spend > 0) {
    chargeRatio = Math.min(1, (fact.spend / fact.views) * 1000 / bid);
    chargeSource = `факт: в среднем ${String(round((fact.spend / fact.views) * 1000, 0))} ₽ за 1000 показов при ставке ${String(bid).replace(".", ",")} ₽`;
  } else if (bid && campaign.paymentType !== 'cpm' && fact.clicks >= 10 && fact.spend > 0) {
    chargeRatio = Math.min(1, fact.spend / fact.clicks / bid);
    chargeSource = `факт: в среднем ${String(round(fact.spend / fact.clicks, 2)).replace(".", ",")} ₽ за клик при ставке ${String(bid).replace(".", ",")} ₽`;
  }

  // Бюджет в день: дневной лимит → факт расхода → остаток бюджета на 7 дней
  let dailyBudget = campaign.dailyLimit || null;
  let budgetSource = dailyBudget ? 'дневной лимит кампании' : null;
  if (!dailyBudget && fact.perDay?.spend > 0 && fact.days >= 3) {
    dailyBudget = fact.perDay.spend;
    budgetSource = 'фактический расход в день';
  }
  if (!dailyBudget && campaign.budgetTotal > 0) {
    dailyBudget = campaign.budgetTotal / 7;
    budgetSource = 'допущение: остаток бюджета кампании на 7 дней';
  }
  const inputs = {
    advertId: campaign.advertId,
    nmId,
    status: campaign.status,
    paymentType: campaign.paymentType,
    bid,
    chargeRatio: round(chargeRatio, 3),
    chargeSource,
    ctr,
    ctrSource,
    cr,
    crSource,
    crLow: crLow != null ? round(crLow, 4) : null,
    crHigh: crHigh != null ? round(crHigh, 4) : null,
    dailyBudget: dailyBudget ? round(dailyBudget, 0) : null,
    budgetSource,
    price,
    profitPerUnit: summary.unit.profitPerUnit,
    buyoutPct: summary.unit.buyoutPct ?? null,
    buyoutLow: summary.unit.buyoutLow ?? null,
    buyoutHigh: summary.unit.buyoutHigh ?? null,
    targetDrrPct: settings.targetDrrPct,
    ...overrides,
  };
  // Клики в день: что реально было при этой ставке (если ставка не менялась) или сколько позволяет бюджет
  const cpc = effectiveCpc(inputs);
  const budgetClicks = inputs.dailyBudget && cpc ? inputs.dailyBudget / cpc : null;
  let clicksPerDay = null;
  let clicksSource = null;
  if (fact.days >= 3 && fact.perDay?.clicks > 0 && overrides.bid == null) {
    clicksPerDay = budgetClicks ? Math.min(fact.perDay.clicks, budgetClicks) : fact.perDay.clicks;
    clicksSource = 'факт кампании';
  } else if (budgetClicks) {
    clicksPerDay = budgetClicks;
    clicksSource = 'допущение: бюджет в день тратится полностью';
  }
  if (overrides.clicksPerDay != null) {
    clicksPerDay = overrides.clicksPerDay;
    clicksSource = 'задано вручную';
  }
  inputs.clicksPerDay = clicksPerDay != null ? round(clicksPerDay, 1) : null;
  inputs.clicksSource = clicksSource;
  return { inputs, summary, fact, organicCr };
}

/**
 * Коридор: худший и лучший варианты по реальным данным.
 * Худший — нижняя граница конверсии и выкупа (90%), лучший — верхняя. «Безопасная ставка» — безубыточная в худшем варианте:
 * до неё реклама не уходит в минус, даже если конверсия и выкуп окажутся у нижней границы.
 */
export function adRange(inputs) {
  const base = adEconomics(inputs);
  if (inputs.crLow == null) return { base, pess: null, opt: null };
  const pess = adEconomics({ ...inputs, cr: inputs.crLow, buyoutPct: inputs.buyoutLow ?? inputs.buyoutPct });
  const opt = adEconomics({ ...inputs, cr: inputs.crHigh, buyoutPct: inputs.buyoutHigh ?? inputs.buyoutPct });
  return { base, pess, opt };
}

/**
 * План бюджета при текущей ставке: что даст дневной бюджет (заказы и прибыль в день — от худшего до лучшего)
 * и сколько ещё потратить, чтобы набрать 100 кликов и получить надёжную конверсию.
 * Клики в день = бюджет ÷ цена клика (если WB тратит бюджет полностью — это видно по факту).
 */
export function budgetPlan(inputs, range, fact, { stockUnits = null } = {}) {
  const cpc = range.base.cpc;
  if (!cpc) return null;
  const budgets = [...new Set([inputs.dailyBudget, 300, 500, 1000, 2000].filter((b) => b > 0).map((b) => Math.round(b)))].sort((a, b) => a - b);
  const line = (budget) => {
    const clicks = budget / cpc;
    const at = (e, cr) => (e && cr != null ? { orders: round(clicks * cr, 1), profit: e.profitPerClick != null ? round(clicks * e.profitPerClick, 0) : null } : null);
    return {
      budget,
      current: budget === Math.round(inputs.dailyBudget || 0),
      clicks: round(clicks, 0),
      pess: at(range.pess, inputs.crLow),
      base: at(range.base, inputs.cr),
      opt: at(range.opt, inputs.crHigh),
      stockDays: stockUnits && inputs.cr ? round(stockUnits / (clicks * inputs.cr), 0) : null,
    };
  };
  const needClicks = Math.max(0, MIN_CLICKS_FOR_CR - (fact.clicks || 0));
  return {
    cpc,
    rows: budgets.map(line),
    test: needClicks > 0 ? { clicks: needClicks, spend: round(needClicks * cpc, 0) } : null,
  };
}

/** Снимок прогноза: при первом появлении кампании и при смене ставки или бюджета. Пишет событие в журнал. */
export function snapshotForecasts(db, settings, today = todayMsk()) {
  const made = [];
  const last = db.prepare('SELECT * FROM ad_forecasts WHERE advert_id = ? AND nm_id = ? ORDER BY id DESC LIMIT 1');
  const insert = db.prepare('INSERT INTO ad_forecasts(advert_id, nm_id, created_at, start_date, reason, inputs_json, forecast_json) VALUES (?,?,?,?,?,?,?)');
  const journal = db.prepare("INSERT INTO journal(date, nm_id, kind, text, created_at) VALUES (?, ?, 'ads', ?, ?)");
  for (const c of listCampaigns(db, { withFinishedDays: 0, today })) {
    if (!LIVE_STATUSES.includes(c.status)) continue;
    for (const nmId of c.nmIds) {
      const { inputs } = adInputs(db, settings, c, nmId, today);
      const prev = last.get(c.advertId, nmId);
      const prevInputs = prev ? parse(prev.inputs_json, {}) : null;
      const bidUnit = c.paymentType === 'cpm' ? '₽ за 1000 показов' : '₽ за клик';
      let reason = null;
      if (!prev) reason = `Кампания «${c.name}» (${c.paymentType === 'cpm' ? 'оплата за показы' : 'оплата за клик'}): ставка ${inputs.bid ?? '—'} ${bidUnit}`;
      else if (inputs.bid != null && prevInputs.bid == null) reason = `Кампания «${c.name}» (${c.paymentType === 'cpm' ? 'оплата за показы' : 'оплата за клик'}): ставка ${inputs.bid} ${bidUnit}`;
      else if (inputs.bid != null && prevInputs.bid !== inputs.bid) reason = `Ставка в «${c.name}»: ${prevInputs.bid ?? '—'} → ${inputs.bid} ${bidUnit}`;
      else if (inputs.dailyBudget && prevInputs.dailyBudget && Math.abs(inputs.dailyBudget - prevInputs.dailyBudget) / prevInputs.dailyBudget > 0.2 && inputs.budgetSource === 'дневной лимит кампании') {
        reason = `Дневной лимит в «${c.name}»: ${prevInputs.dailyBudget} → ${inputs.dailyBudget} ₽`;
      }
      if (!reason) continue;
      const forecast = adEconomics(inputs);
      insert.run(c.advertId, nmId, nowIso(), today, reason, JSON.stringify(inputs), JSON.stringify(forecast));
      const tail = forecast.drrPct != null ? ` Прогноз: ДРР ${String(forecast.drrPct).replace('.', ',')}%, заказ с рекламы ${forecast.costPerOrder} ₽${forecast.perDay ? `, ~${String(forecast.perDay.orders).replace('.', ',')} заказа в день` : ''}.` : '';
      journal.run(today, nmId, `${reason}.${tail}`, nowIso());
      made.push({ advertId: c.advertId, nmId, reason });
    }
  }
  return made;
}

const pick = (e) => ({ profitPerClick: e.profitPerClick, profitPer100Clicks: e.profitPer100Clicks, profitPerOrder: e.profitPerOrder, costPerOrder: e.costPerOrder, drrPct: e.drrPct, profitPerOrderAfterAds: e.profitPerOrderAfterAds, breakEvenBid: e.breakEvenBid, targetBid: e.targetBid, adShareOfMarginPct: e.adShareOfMarginPct });

/** Карточки «Реклама»: каждая кампания × товар — вводные, прогноз, факт, сравнение, сценарии и советы. */
export function adsOverview(db, settings, today = todayMsk()) {
  const out = [];
  for (const c of listCampaigns(db, { today })) {
    for (const nmId of c.nmIds) {
      const { inputs, summary, fact, organicCr } = adInputs(db, settings, c, nmId, today);
      const range = adRange(inputs);
      const econ = range.base;
      const forecasts = db
        .prepare('SELECT id, created_at, start_date, reason, inputs_json, forecast_json FROM ad_forecasts WHERE advert_id = ? AND nm_id = ? ORDER BY id')
        .all(c.advertId, nmId)
        .map((f) => ({ id: f.id, createdAt: f.created_at, startDate: f.start_date, reason: f.reason, inputs: parse(f.inputs_json, {}), forecast: parse(f.forecast_json, {}) }));
      const current = forecasts.at(-1) || null;
      const factSinceForecast = current ? adFact(db, c.advertId, nmId, current.startDate, today, inputs.price, { withOthers: c.nmIds.length <= 1 }) : null;
      const recommended = c.recommended?.[nmId] || null;
      out.push({
        campaign: { ...c, nmIds: undefined },
        nmId,
        product: { title: summary.title, vendorCode: summary.vendorCode, price: inputs.price, cost: summary.cost, stocks: summary.snapshot.stocks_wb, stockDays: summary.stockDays },
        unit: summary.unit,
        inputs,
        economics: econ,
        range: range.pess ? {
          crLow: inputs.crLow, crHigh: inputs.crHigh, buyoutLow: inputs.buyoutLow, buyoutHigh: inputs.buyoutHigh,
          pess: pick(range.pess), opt: pick(range.opt),
        } : null,
        budget: budgetPlan(inputs, range, fact, { stockUnits: summary.snapshot.stocks_wb }),
        recommended,
        fact,
        forecast: current,
        forecastHistory: forecasts.slice(0, -1).map((f) => ({ createdAt: f.createdAt, reason: f.reason, drrPct: f.forecast.drrPct, perDay: f.forecast.perDay })),
        comparison: current ? compareForecast(current.forecast, factSinceForecast) : null,
        factSinceForecast,
        scenarios: bidScenarios(inputs, { extraBids: [econ.breakEvenBid, econ.targetBid, recommended?.competitive].filter(Boolean) }),
        recommendations: adRecommendations({ econ, range, fact, inputs, recommended, organicCr, stockDays: summary.stockDays, settings }),
      });
    }
  }
  return out;
}

/** Калькулятор: пересчёт по кампании с другими ставкой, бюджетом, конверсией или CTR. */
export function adsCalc(db, settings, { advertId, nmId, bid, dailyBudget, crPct, ctrPct, clicksPerDay }, today = todayMsk()) {
  const c = listCampaigns(db, { today, withFinishedDays: 365 }).find((x) => x.advertId === advertId);
  if (!c) return null;
  const overrides = {};
  if (bid != null) overrides.bid = bid;
  if (dailyBudget != null) {
    overrides.dailyBudget = dailyBudget;
    overrides.budgetSource = 'задано вручную';
  }
  if (crPct != null) {
    overrides.cr = crPct / 100;
    overrides.crSource = 'задано вручную';
  }
  if (ctrPct != null) {
    overrides.ctr = ctrPct / 100;
    overrides.ctrSource = 'задано вручную';
  }
  if (clicksPerDay != null) overrides.clicksPerDay = clicksPerDay;
  const base = adInputs(db, settings, c, nmId, today);
  const { inputs } = adInputs(db, settings, c, nmId, today, overrides);
  // Новая ставка: клики масштабируем от факта при текущей ставке (допущение), но не больше бюджета
  if (bid != null && base.inputs.bid && base.inputs.clicksPerDay != null && clicksPerDay == null) {
    let clicks = base.inputs.clicksPerDay * (bid / base.inputs.bid) ** VOLUME_ELASTICITY;
    const cpc = effectiveCpc(inputs);
    if (inputs.dailyBudget && cpc) clicks = Math.min(clicks, inputs.dailyBudget / cpc);
    inputs.clicksPerDay = round(clicks, 1);
    inputs.clicksSource = 'допущение: клики меняются медленнее ставки, не больше бюджета';
  }
  const econ = adEconomics(inputs);
  return { inputs, economics: econ, scenarios: bidScenarios(inputs, { extraBids: [econ.breakEvenBid, econ.targetBid].filter(Boolean) }) };
}
