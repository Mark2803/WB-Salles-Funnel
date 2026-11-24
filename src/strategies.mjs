// Библиотека стратегий и симулятор воронки.
//
// Как устроен прогноз: берём средние показатели товара за 14 дней (базовая линия) и применяем
// к ним эффекты стратегии. Эффекты — это ДОПУЩЕНИЯ, а не факт: их значения видны и меняются
// в параметрах. После запуска стратегии прогноз сравнивается с фактом («план против факта»).
import { unitEconomics } from './metrics.mjs';
import { addDays } from './dates.mjs';

const P = (key, label, def, min, max, step, unit, hint, kind = 'param') => ({ key, label, default: def, min, max, step, unit, hint, kind });

export const STRATEGIES = [
  {
    key: 'seo',
    name: 'Бесплатный старт: SEO и контент',
    stage: 'Этап 1 — бесплатно',
    summary: 'Карточка начинает попадать в нужные запросы и лучше продаёт без вложений.',
    whenToUse: 'Всегда первым шагом. Особенно если мало переходов или конверсия в корзину ниже 10%.',
    steps: [
      'Собрать 30–50 запросов: «ча гао», «чайная паста», «пуэр шу», «смола пуэра», «растворимый пуэр», «габа чай»',
      'Название — самый частотный точный запрос (до 60 символов), заполнить все характеристики',
      'Главное фото: продукт + упаковка + 1–2 крупных тезиса (вес, число порций)',
      'Слайды: как заваривать, вкус, состав, упаковка внутри; короткое видео заваривания',
      'Ответить на все вопросы и отзывы, вложить в посылку карточку «как заваривать»',
    ],
    entry: ['Нет условий — делать сразу'],
    stop: ['Нечего останавливать: результат проверяем через 2 недели по переходам и конверсии в корзину'],
    risks: 'Эффект приходит за 1–3 недели и зависит от качества контента; цифры ниже — оценка.',
    params: [
      P('organicLiftPct', 'Рост бесплатных переходов', 20, 0, 100, 5, '%', 'Допущение: насколько вырастут переходы из поиска после SEO', 'assumption'),
      P('convLiftPct', 'Рост конверсии в корзину', 10, 0, 50, 5, '%', 'Допущение: эффект новых фото и описания', 'assumption'),
      P('rampDays', 'Срок выхода на эффект', 14, 1, 45, 1, 'дн.', 'За сколько дней эффект набирает полную силу', 'assumption'),
    ],
    effects: (p) => ({ organicMult: 1 + p.organicLiftPct / 100, cartConvMult: 1 + p.convLiftPct / 100, rampDays: p.rampDays }),
  },
  {
    key: 'reviews',
    name: 'Отзывы за баллы',
    stage: 'Этап 2 — недорого',
    summary: '15–20 настоящих отзывов поднимают CTR и конверсию — самый дешёвый рычаг перед рекламой.',
    whenToUse: 'Когда у товара меньше 15 отзывов или рейтинг ниже 4,7.',
    steps: [
      'Включить «Баллы за отзывы» на товар (запуск — со следующего дня)',
      'Минимум 100 баллов за текст, 150 — с фото; каждый балл стоит ~1,46 ₽',
      'Отвечать на каждый отзыв в течение суток',
      'Выключить, когда набрано 20–30 отзывов',
    ],
    entry: ['Товар в наличии на складе WB', 'Упаковка и качество в порядке (иначе отзывы будут плохими)'],
    stop: ['Набрано 20–30 отзывов', 'Новые отзывы приходят с оценкой ниже 4 — сначала исправить товар'],
    risks: 'Отзывы за баллы получают и с низкой оценкой — если с товаром есть проблема, она станет заметнее.',
    params: [
      P('reviews', 'Сколько отзывов собрать', 15, 5, 50, 1, 'шт.', 'Число отзывов за баллы'),
      P('pointsPerReview', 'Баллов за отзыв', 100, 100, 500, 10, 'баллов', 'Минимум WB — 100 за текст'),
      P('convLiftPct', 'Рост конверсии в корзину', 20, 0, 60, 5, '%', 'Допущение: эффект 15+ отзывов по сравнению с почти пустой карточкой', 'assumption'),
      P('rampDays', 'Срок набора отзывов', 21, 7, 60, 1, 'дн.', 'За сколько дней соберутся отзывы', 'assumption'),
    ],
    effects: (p, s) => ({ cartConvMult: 1 + p.convLiftPct / 100, rampDays: p.rampDays, oneTimeCost: p.reviews * p.pointsPerReview * s.costPerReviewPoint }),
  },
  {
    key: 'discount',
    name: 'Скидка / участие в акции WB',
    stage: 'Этап 3 — скидки',
    summary: 'Ниже цена — выше конверсия и прибавка к ранжированию за участие в акции. Платим маржой.',
    whenToUse: 'После отзывов. В сезон (декабрь, 23 февраля, 8 марта) и для разгона новой карточки на 6–8 недель.',
    steps: [
      'Проверить: прибыль с продажи по новой цене минус реклама больше нуля',
      'Записать, во сколько раз должны вырасти продажи, чтобы скидка окупилась',
      'На 3–4 день акции сравнить заказы в день с неделей до неё',
      'Скидку снижать шагами по 3–5 п.п., пока заказы не падают больше чем на 10%',
    ],
    entry: ['Есть 10+ отзывов', 'Цена после скидки выше цены безубыточности'],
    stop: ['Продажи выросли меньше нужного множителя, а цель — прибыль', 'Прибыль с продажи после рекламы ушла в минус'],
    risks: 'Скидки складываются (промокод + акция + «Хочу скидку»). Держите минимальную цену в кабинете.',
    params: [
      P('discountPct', 'Скидка продавца', 10, 0, 50, 1, '%', 'На сколько снижаем свою цену'),
      P('elasticity', 'Чувствительность к цене', 1.5, 0, 4, 0.1, '×', 'Допущение: −1% цены даёт +1,5% к конверсии в корзину', 'assumption'),
      P('rankingLiftPct', 'Прибавка показов за акцию', 15, 0, 50, 5, '%', 'Допущение: акции WB поднимают карточку в выдаче (по данным WB — 7–35%)', 'assumption'),
      P('rampDays', 'Срок выхода на эффект', 5, 1, 30, 1, 'дн.', 'За сколько дней акция набирает эффект', 'assumption'),
    ],
    effects: (p) => ({ priceMult: 1 - p.discountPct / 100, cartConvMult: 1 + (p.elasticity * p.discountPct) / 100, organicMult: 1 + p.rankingLiftPct / 100, rampDays: p.rampDays }),
  },
  {
    key: 'ads_cpc',
    name: 'Реклама с оплатой за клик (CPC)',
    stage: 'Этап 4 — реклама',
    summary: 'Платим только за переходы в карточку. Безопасный старт рекламы для новой карточки.',
    whenToUse: 'Когда 15+ отзывов, рейтинг 4,7+ и конверсия в корзину от 12%.',
    steps: [
      'Одна кампания на флагман, ставка не выше рабочей цены клика (см. юнит-экономику)',
      'Бюджет 3 000 ₽ на первые 7 дней',
      'Через 7 дней: кластеры без заказов и нерелевантные — в минус-фразы',
      'Реклама на продажу ниже рабочей — бюджет +50% в неделю',
    ],
    entry: ['15+ отзывов и рейтинг ≥ 4,7', 'Конверсия в корзину ≥ 12%', 'Остатка хватит минимум на 3 недели'],
    stop: ['Реклама на продажу выше рабочей 2 недели подряд', 'CTR ниже 2% — сначала менять главное фото'],
    risks: 'При слабой карточке клики есть, а заказов нет. Следите за ДРР в сводке.',
    params: [
      P('dailyBudget', 'Бюджет в день', 500, 100, 10000, 50, '₽', 'Сколько тратим на рекламу в сутки'),
      P('cpc', 'Цена клика', 8, 1, 60, 0.5, '₽', 'Средняя цена клика'),
      P('adConvFactor', 'Конверсия рекламных переходов', 0.9, 0.3, 1.5, 0.05, '×', 'Допущение: доля от обычной конверсии', 'assumption'),
      P('haloPct', 'Рост бесплатного трафика от продаж', 10, 0, 50, 5, '%', 'Допущение: продажи с рекламы поднимают карточку в поиске', 'assumption'),
      P('rampDays', 'Срок выхода на эффект', 7, 1, 30, 1, 'дн.', 'Для роста бесплатного трафика', 'assumption'),
    ],
    effects: (p) => ({ extraClicksPerDay: p.dailyBudget / p.cpc, adSpendPerDay: p.dailyBudget, adConvFactor: p.adConvFactor, organicMult: 1 + p.haloPct / 100, rampDays: p.rampDays }),
  },
  {
    key: 'ads_cpm',
    name: 'Реклама с оплатой за показы (CPM)',
    stage: 'Этап 4 — реклама',
    summary: 'Платим за 1000 показов. Выгоднее CPC, когда CTR карточки стабильно выше 3%.',
    whenToUse: 'После CPC, когда карточка хорошо кликается.',
    steps: [
      'Единая ставка — для первых кампаний; ручная — когда понятно, какие зоны работают',
      'Рабочая ставка CPM = цена клика × CTR × 1000',
      'Каждую неделю проверять стоимость заказа и ДРР',
    ],
    entry: ['CTR рекламы стабильно ≥ 3%', 'Есть опыт CPC с рекламой на продажу ниже рабочей'],
    stop: ['CTR упал ниже 2%', 'Реклама на продажу выше рабочей 2 недели подряд'],
    risks: 'Падение CTR с 3% до 2% почти обнуляет прибыль при той же ставке.',
    params: [
      P('dailyBudget', 'Бюджет в день', 500, 100, 10000, 50, '₽', 'Сколько тратим на рекламу в сутки'),
      P('cpm', 'Ставка за 1000 показов', 250, 50, 2000, 10, '₽', 'CPM'),
      P('adCtrPct', 'CTR рекламы', 3, 0.5, 10, 0.1, '%', 'Допущение: доля кликов от показов', 'assumption'),
      P('adConvFactor', 'Конверсия рекламных переходов', 0.9, 0.3, 1.5, 0.05, '×', 'Допущение: доля от обычной конверсии', 'assumption'),
      P('haloPct', 'Рост бесплатного трафика от продаж', 10, 0, 50, 5, '%', 'Продажи с рекламы поднимают карточку в поиске', 'assumption'),
      P('rampDays', 'Срок выхода на эффект', 7, 1, 30, 1, 'дн.', 'Для роста бесплатного трафика', 'assumption'),
    ],
    effects: (p) => ({ extraClicksPerDay: (p.dailyBudget / p.cpm) * 1000 * (p.adCtrPct / 100), adSpendPerDay: p.dailyBudget, adConvFactor: p.adConvFactor, organicMult: 1 + p.haloPct / 100, rampDays: p.rampDays }),
  },
  {
    key: 'combo',
    name: 'Комплексный разгон',
    stage: 'Этапы 2–4 вместе',
    summary: 'Отзывы + небольшая скидка + реклама за клики одновременно. Быстрее, но дороже.',
    whenToUse: 'Сезон (подарки) или когда нужно быстро набрать историю продаж у флагмана.',
    steps: ['Включить баллы за отзывы', 'Скидка 10% на 6–8 недель', 'Реклама CPC с бюджетом из параметров', 'Еженедельно сверять план и факт'],
    entry: ['Товар в наличии на 4+ недели', 'Юнит-экономика выдерживает скидку и рекламу'],
    stop: ['Прибыль после продвижения в минусе 2 недели подряд'],
    risks: 'Самые большие вложения; эффекты разных рычагов складываются не полностью.',
    params: [
      P('discountPct', 'Скидка продавца', 10, 0, 40, 1, '%', 'На сколько снижаем свою цену'),
      P('reviews', 'Отзывов за баллы', 15, 0, 50, 1, 'шт.', 'Сколько отзывов собрать (100 баллов за отзыв)'),
      P('dailyBudget', 'Бюджет рекламы в день', 500, 0, 10000, 50, '₽', 'Реклама с оплатой за клик'),
      P('cpc', 'Цена клика', 8, 1, 60, 0.5, '₽', 'Средняя цена клика'),
      P('convLiftPct', 'Рост конверсии от отзывов', 20, 0, 60, 5, '%', 'Насколько вырастет конверсия в корзину, когда наберётся 10+ отзывов', 'assumption'),
      P('elasticity', 'Чувствительность к цене', 1.5, 0, 4, 0.1, '×', '−1% цены даёт +1,5% к конверсии в корзину', 'assumption'),
      P('organicLiftPct', 'Рост бесплатного трафика (акция + продажи)', 20, 0, 80, 5, '%', 'Акции и продажи с рекламы поднимают карточку в поиске', 'assumption'),
      P('rampDays', 'Срок выхода на эффект', 14, 1, 45, 1, 'дн.', 'За сколько дней эффект набирает полную силу', 'assumption'),
    ],
    effects: (p, s) => ({
      priceMult: 1 - p.discountPct / 100,
      cartConvMult: (1 + (p.reviews >= 10 ? p.convLiftPct : (p.convLiftPct * p.reviews) / 10) / 100) * (1 + (p.elasticity * p.discountPct) / 100),
      organicMult: 1 + p.organicLiftPct / 100,
      extraClicksPerDay: p.cpc > 0 ? p.dailyBudget / p.cpc : 0,
      adSpendPerDay: p.dailyBudget,
      adConvFactor: 0.9,
      rampDays: p.rampDays,
      oneTimeCost: p.reviews * 100 * s.costPerReviewPoint,
    }),
  },
];

export function getStrategy(key) {
  return STRATEGIES.find((s) => s.key === key) || null;
}

export function defaultParams(strategy) {
  return Object.fromEntries(strategy.params.map((p) => [p.key, p.default]));
}

export function normalizeParams(strategy, input = {}) {
  const out = {};
  for (const p of strategy.params) {
    let v = Number(input[p.key]);
    if (!Number.isFinite(v)) v = p.default;
    out[p.key] = Math.min(p.max, Math.max(p.min, v));
  }
  return out;
}

// Публичное описание стратегий (без функций) — для интерфейса
export function strategyCatalog() {
  return STRATEGIES.map(({ effects, ...rest }) => rest);
}

// ---------- Симулятор ----------
// Возвращает прогноз по дням и итоги для сценария «как сейчас» и «со стратегией».
export function simulate({ baseline, settings, strategyKey, params, days = 30, startDate }) {
  const strategy = strategyKey ? getStrategy(strategyKey) : null;
  if (strategyKey && !strategy) throw new Error('Неизвестная стратегия');
  const p = strategy ? normalizeParams(strategy, params) : {};
  const e = strategy ? strategy.effects(p, settings) : {};
  const eff = {
    organicMult: e.organicMult ?? 1,
    cartConvMult: e.cartConvMult ?? 1,
    priceMult: e.priceMult ?? 1,
    extraClicksPerDay: e.extraClicksPerDay ?? 0,
    adSpendPerDay: e.adSpendPerDay ?? 0,
    adConvFactor: e.adConvFactor ?? 1,
    rampDays: Math.max(1, e.rampDays ?? 1),
    oneTimeCost: e.oneTimeCost ?? 0,
  };
  const run = (withStrategy) => {
    const price = (baseline.price ?? 0) * (withStrategy ? eff.priceMult : 1);
    const unit = unitEconomics({ price, cost: baseline.cost, settings, actual: baseline.actual ? { ...baseline.actual, buyoutPct: baseline.buyoutPct * 100 } : null, tariff: baseline.tariff });
    const daily = [];
    for (let d = 1; d <= days; d++) {
      const ramp = withStrategy ? Math.min(1, d / eff.rampDays) : 0;
      const organicMult = 1 + (eff.organicMult - 1) * ramp;
      const convMult = 1 + (eff.cartConvMult - 1) * ramp;
      const cartConv = Math.min(0.6, baseline.cartConv * convMult);
      const organicOpens = baseline.organicOpensPerDay * organicMult;
      const currentAdClicks = baseline.adClicksPerDay;
      const extraClicks = withStrategy ? eff.extraClicksPerDay : 0;
      const opens = organicOpens + currentAdClicks + extraClicks;
      const carts = (organicOpens + currentAdClicks) * cartConv + extraClicks * cartConv * eff.adConvFactor;
      const orders = carts * baseline.orderConv;
      const buyouts = orders * baseline.buyoutPct;
      const spend = baseline.adSpendPerDay + (withStrategy ? eff.adSpendPerDay : 0) + (withStrategy && d === 1 ? eff.oneTimeCost : 0);
      const revenue = buyouts * price;
      const profit = unit.profitPerUnit != null ? buyouts * unit.profitPerUnit - spend : null;
      daily.push({ day: d, date: startDate ? addDays(startDate, d - 1) : null, opens, carts, orders, buyouts, spend, revenue, profit });
    }
    const sum = (k) => daily.reduce((s, x) => s + (x[k] ?? 0), 0);
    const totals = {
      opens: Math.round(sum('opens')),
      carts: Math.round(sum('carts')),
      orders: Math.round(sum('orders')),
      buyouts: Math.round(sum('buyouts')),
      spend: Math.round(sum('spend')),
      revenue: Math.round(sum('revenue')),
      profit: unit.profitPerUnit != null ? Math.round(sum('profit')) : null,
      price: Math.round(price),
      profitPerUnit: unit.profitPerUnit,
      breakEvenPrice: unit.breakEvenPrice,
    };
    totals.drr = totals.revenue ? Math.round((totals.spend / (totals.orders * price || 1)) * 1000) / 10 : null;
    totals.costPerExtraOrder = null;
    return { daily: daily.map(roundDay), totals };
  };
  const base = run(false);
  const scenario = strategy ? run(true) : base;
  if (strategy) {
    const extraOrders = scenario.totals.orders - base.totals.orders;
    const extraSpend = scenario.totals.spend - base.totals.spend;
    scenario.totals.costPerExtraOrder = extraOrders > 0 ? Math.round(extraSpend / extraOrders) : null;
  }
  const warnings = [];
  if (!baseline.enoughData) warnings.push('Мало данных за 14 дней — конверсии взяты по умолчанию (12% в корзину, 50% в заказ). Прогноз грубый.');
  if (baseline.cost == null) warnings.push('Не указана себестоимость товара — прибыль не считается. Укажите её на вкладке «Настройки».');
  if (scenario.totals.profitPerUnit != null && scenario.totals.profitPerUnit < 0) warnings.push('При этой цене каждая продажа убыточна ещё до рекламы.');
  if (scenario.totals.profit != null && base.totals.profit != null && scenario.totals.profit < base.totals.profit)
    warnings.push('Стратегия увеличивает продажи, но прибыль за период ниже, чем без неё. Это нормально для разгона, если цель — история продаж.');
  return { strategyKey: strategy?.key ?? null, params: p, effects: eff, baseline, base, scenario, warnings, days };
}

function roundDay(d) {
  const r = (v, k = 1) => (v == null ? null : Math.round(v * k) / k);
  return { ...d, opens: r(d.opens, 10), carts: r(d.carts, 10), orders: r(d.orders, 100), buyouts: r(d.buyouts, 100), spend: r(d.spend), revenue: r(d.revenue), profit: r(d.profit) };
}

// ---------- План против факта ----------
export function planVsFact(db, plan, today) {
  if (!plan.start_date || !plan.forecast_json) return null;
  const forecast = JSON.parse(plan.forecast_json);
  const rows = db
    .prepare('SELECT date, open_count, cart_count, order_count, buyout_count FROM funnel_daily WHERE nm_id = ? AND date >= ? AND date <= ? ORDER BY date')
    .all(plan.nm_id, plan.start_date, today);
  const ads = db
    .prepare('SELECT date, SUM(spend) spend FROM ads_daily WHERE nm_id = ? AND date >= ? AND date <= ? GROUP BY date')
    .all(plan.nm_id, plan.start_date, today);
  const factBy = Object.fromEntries(rows.map((r) => [r.date, r]));
  const adsBy = Object.fromEntries(ads.map((r) => [r.date, r.spend]));
  let cumPlan = 0;
  let cumFact = 0;
  const days = forecast.scenario.daily
    .filter((d) => d.date && d.date <= today)
    .map((d) => {
      const f = factBy[d.date];
      cumPlan += d.orders;
      cumFact += f ? f.order_count : 0;
      return { date: d.date, planOrders: d.orders, factOrders: f ? f.order_count : null, planOpens: d.opens, factOpens: f ? f.open_count : null, factSpend: adsBy[d.date] ?? 0, cumPlan: Math.round(cumPlan * 10) / 10, cumFact };
    });
  const progress = cumPlan > 0 ? Math.round((cumFact / cumPlan) * 100) : null;
  return { days, cumPlan: Math.round(cumPlan), cumFact, progress };
}
