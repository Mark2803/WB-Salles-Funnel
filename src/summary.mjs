// «Получить сводку для ИИ»: одна сводка по всей «Воронке» (товары, юнит-экономика, реклама, стратегии, журнал, отзывы, тарифы, настройки) — текст в Markdown, который можно вставить в чат и обсуждать стратегию на живых цифрах.
import { addDays, todayMsk } from './dates.mjs';
import { overview } from './metrics.mjs';
import { getStrategy, planVsFact } from './strategies.mjs';
import { adsOverview } from './ads.mjs';

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const fmt = (v, suffix = '') => (v == null ? '—' : Object.is(v, -0) ? `0${suffix}` : `${typeof v === 'number' ? v.toLocaleString('ru-RU') : v}${suffix}`);

export function buildClaudeSummary(db, settings, today = todayMsk()) {
  const items = overview(db, settings, today);
  const lines = [];
  lines.push(`# Воронка WB — сводка на ${today}`);
  lines.push('');
  lines.push('Период: последние 7 дней (в скобках — изменение к прошлым 7 дням). Органических показов в API WB нет, воронка начинается с переходов в карточку.');
  lines.push('');
  lines.push('| Артикул | Товар | Цена продавца, ₽ | Остаток | Переходы | В корзину | Заказы | Выкупы | Конв. корзина | Конв. заказ | Реклама, ₽ | ДРР | Маржа за 7 дн., ₽ | Реклама / маржа | Ожидаемая прибыль за 7 дн., ₽ | Рейтинг |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const p of items) {
    const w = p.week;
    lines.push(
      `| ${p.nmId} | ${p.title || p.vendorCode || ''} | ${fmt(p.snapshot.seller_price)} | ${fmt(p.snapshot.stocks_wb)}${p.stockDays != null ? ` (~${p.stockDays} дн.)` : ''} | ${fmt(w.open)} (${fmt(p.changes.open, '%')}) | ${fmt(w.cart)} | ${fmt(w.orders)} (${fmt(p.changes.orders, '%')}) | ${fmt(w.buyouts)} | ${fmt(w.cartConv, '%')} | ${fmt(w.orderConv, '%')} | ${fmt(w.ads.spend)} | ${fmt(w.ads.drr, '%')} | ${fmt(p.weekMargin)} | ${fmt(p.adShareOfMarginPct, '%')} | ${fmt(p.weekProfit)} | ${p.snapshot.feedback_rating ? fmt(p.snapshot.feedback_rating) : 'нет отзывов'} |`,
    );
  }
  lines.push('');
  lines.push('## Юнит-экономика');
  for (const p of items) {
    const u = p.unit;
    lines.push(
      `- ${p.nmId}: цена ${fmt(u.price, ' ₽')}, себестоимость ${fmt(u.cost, ' ₽')}, комиссия ${fmt(u.commissionPct, '%')}, налог ${fmt(u.taxPct, '%')}, логистика на продажу ${fmt(u.logisticsPerSold, ' ₽')}, хранение на продажу ${fmt(u.storagePerSold, ' ₽')}, выкуп ${fmt(u.buyoutPct, '%')}${u.buyoutLow != null ? ` (диапазон ${fmt(u.buyoutLow)}…${fmt(u.buyoutHigh, '%')})` : ''}, маржа (прибыль с продажи до рекламы) ${fmt(u.profitPerUnit, ' ₽')} = ${fmt(u.marginPct, '%')} от цены, безубыточность ${fmt(u.breakEvenPrice, ' ₽')}, рабочая реклама на продажу ${fmt(u.workAdPerSale, ' ₽')}. Источники — выкуп: ${u.buyoutSource || '—'}; комиссия: ${u.commissionSource}; логистика: ${u.logisticsSource}; хранение: ${u.storageSource}.${u.missing?.length ? ` Расчёт неполный: нет ${u.missing.join(', ')}.` : ''}`,
    );
  }
  lines.push('');
  lines.push('## Тревоги');
  let any = false;
  for (const p of items) {
    for (const a of p.alerts.filter((x) => x.level !== 'info')) {
      lines.push(`- [${a.level === 'critical' ? 'критично' : 'внимание'}] ${p.nmId}: ${a.text}`);
      any = true;
    }
  }
  if (!any) lines.push('- нет');
  lines.push('');
  lines.push('## Рекламные кампании');
  const ads = adsOverview(db, settings, today);
  if (!ads.length) lines.push('- нет');
  for (const a of ads) {
    const c = a.campaign;
    const e = a.economics;
    const f = a.fact;
    lines.push(`- ${a.nmId} «${c.name}» (${c.paymentLabel}, ${c.statusLabel}): ставка ${fmt(a.inputs.bid)} ₽, цена клика ${fmt(e.cpc)} ₽, бюджет в день ${fmt(a.inputs.dailyBudget, ' ₽')}. Факт с ${f.from}: показы ${fmt(f.views)}, клики ${fmt(f.clicks)}, CTR ${fmt(f.ctr, '%')}, заказы ${fmt(f.orders)}, расход ${fmt(f.spend, ' ₽')}, ДРР ${fmt(f.drrPct, '%')}. Расчёт: конверсия ${fmt(e.cr, '%')} (${a.inputs.crSource}), ДРР ${fmt(e.drrPct, '%')}, прибыль с заказа после рекламы ${fmt(e.profitPerOrderAfterAds, ' ₽')}, реклама съедает ${fmt(e.adShareOfMarginPct, '%')} маржи, безубыточная ставка ${fmt(e.breakEvenBid)}, ставка под цель ${fmt(e.targetBid)}.`);
    const g = a.range;
    if (g) {
      lines.push(`  - Коридор (90%): конверсия ${fmt(round1(g.crLow * 100))}…${fmt(round1(g.crHigh * 100), '%')}, выкуп ${fmt(g.buyoutLow)}…${fmt(g.buyoutHigh, '%')}. Прибыль с заказа после рекламы: худший ${fmt(g.pess.profitPerOrderAfterAds, ' ₽')}, ожидаемый ${fmt(e.profitPerOrderAfterAds, ' ₽')}, лучший ${fmt(g.opt.profitPerOrderAfterAds, ' ₽')}. Безубыточная ставка: худший ${fmt(g.pess.breakEvenBid)}, ожидаемый ${fmt(e.breakEvenBid)}, лучший ${fmt(g.opt.breakEvenBid)}. Безопасно (в плюс даже в худшем) — ставка до ${fmt(g.pess.breakEvenBid)}.`);
    }
    if (a.budget) {
      lines.push(`  - Бюджет в день при нынешней ставке (клик ${fmt(a.budget.cpc)} ₽): ${a.budget.rows.map((r) => `${r.budget} ₽ → ${fmt(r.clicks)} кликов, заказов ${fmt(r.pess?.orders)}…${fmt(r.opt?.orders)}, прибыль ${fmt(r.pess?.profit)}…${fmt(r.opt?.profit)} ₽/день`).join('; ')}.${a.budget.test ? ` До надёжной конверсии ещё ${a.budget.test.clicks} кликов ≈ ${a.budget.test.spend} ₽.` : ''}`);
    }
    for (const r of a.recommendations) lines.push(`  - ${r.text}`);
  }
  lines.push('');
  const plans = db.prepare("SELECT * FROM plans WHERE status = 'active' ORDER BY id").all();
  lines.push('## Активные стратегии');
  if (!plans.length) lines.push('- нет');
  for (const plan of plans) {
    const s = getStrategy(plan.strategy_key);
    const pf = planVsFact(db, plan, today);
    lines.push(`- ${plan.nm_id}: «${s?.name || plan.strategy_key}» с ${plan.start_date}. Параметры: ${plan.params_json}. План заказов на сегодня ${fmt(pf?.cumPlan)}, факт ${fmt(pf?.cumFact)} (${fmt(pf?.progress, '%')} плана).${plan.note ? ` Заметка: ${plan.note}` : ''}`);
  }
  lines.push('');
  const journal = db.prepare('SELECT date, nm_id, kind, text FROM journal WHERE date >= ? ORDER BY date DESC, id DESC LIMIT 30').all(addDays(today, -30));
  lines.push('## Журнал действий за 30 дней');
  if (!journal.length) lines.push('- пусто');
  for (const j of journal) lines.push(`- ${j.date}${j.nm_id ? ` (${j.nm_id})` : ''}: ${j.text}`);
  lines.push('');
  const neg = db
    .prepare('SELECT nm_id, created_at, rating, text, cons FROM feedbacks WHERE rating <= 3 AND created_at >= ? ORDER BY created_at DESC LIMIT 10')
    .all(addDays(today, -30));
  lines.push('## Негативные отзывы за 30 дней');
  if (!neg.length) lines.push('- нет');
  for (const f of neg) lines.push(`- ${String(f.created_at).slice(0, 10)} ${f.nm_id}, ${f.rating}★: ${(f.text || f.cons || '').slice(0, 200)}`);
  lines.push('');
  const tariffs = db.prepare('SELECT changed_at, item, field, old_value, new_value FROM tariff_changes WHERE changed_at >= ? ORDER BY changed_at DESC LIMIT 20').all(addDays(today, -30));
  lines.push('## Изменения тарифов WB за 30 дней');
  if (!tariffs.length) lines.push('- нет');
  for (const t of tariffs) lines.push(`- ${String(t.changed_at).slice(0, 10)} ${t.item} — ${t.field}: ${fmt(t.old_value)} → ${fmt(t.new_value)}`);
  lines.push('');
  lines.push(`Настройки: цель ДРР ${settings.targetDrrPct}%, желаемая прибыль после рекламы ${settings.targetProfitPerUnit} ₽/шт., налог ${settings.taxPct != null ? `${settings.taxPct}%` : 'не задан'}.`);
  return lines.join('\n');
}
