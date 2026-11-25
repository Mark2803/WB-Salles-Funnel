// Интерфейс инструмента «WB Воронка». Одна страница, переключение вкладок по адресу (#/...).
(function () {
  'use strict';
  const $app = document.getElementById('app');
  const C = window.Charts;

  // Шпаргалка: что значит каждый показатель. Наведите мышку (или нажмите) на подчёркнутое слово.
  const TERMS = {
    'Показы': { text: 'Сколько раз карточку показали покупателям в рекламе (поиск или рекомендации).', act: 'Мало показов — ставка ниже конкурентов или узкие запросы.' },
    'Клики': { text: 'Сколько раз покупатели нажали на рекламную карточку.', act: '' },
    CTR: { text: 'Кликабельность: из 100 увидевших карточку сколько кликнули. CTR = клики ÷ показы × 100%. В поиске WB обычно 3–8%.', act: 'Низкий CTR — меняйте главное фото, название, цену. Ставка тут не поможет.' },
    CPC: { text: 'Цена клика: сколько вы реально заплатили за один клик. CPC = затраты ÷ клики. На WB это обычно меньше ставки (аукцион второй цены).', act: 'Сравнивайте с безубыточной ставкой на этой же странице.' },
    CPM: { text: 'Цена 1000 показов. CPM = затраты ÷ показы × 1000. Главное для кампаний с оплатой за показы; при оплате за клики — справочно.', act: '' },
    'Корзины': { text: 'Сколько раз после клика по рекламе товар положили в корзину (включая другие ваши товары).', act: 'Кладут, но не заказывают — цена, срок доставки или отзывы.' },
    'Заказы': { text: 'Заказы после клика по рекламе — как в отчёте WB, вместе с заказами других ваших товаров.', act: '' },
    CR: { text: 'Конверсия: из 100 кликнувших сколько заказали. CR = заказы ÷ клики × 100%. Надёжна примерно после 100 кликов.', act: 'Низкий CR — дело в карточке: отзывы, рейтинг, описание, цена против конкурентов.' },
    'Затраты': { text: 'Сколько списано за рекламу за период.', act: '' },
    CPO: { text: 'Цена заказа: сколько рекламы ушло на один заказ. CPO = затраты ÷ заказы. Главный показатель.', act: 'CPO меньше прибыли с заказа — реклама в плюс; больше — в минус.' },
    CPS: { text: 'Цена продажи (выкупа): затраты ÷ выкупы. Как CPO, но с учётом невыкупов. У чая выкуп ~95%, поэтому CPS ≈ CPO ÷ 0,95.', act: '' },
    'Сумма заказов': { text: 'На сколько рублей заказали после клика по рекламе (в ценах покупателя).', act: '' },
    'ДРР': { text: 'Доля рекламных расходов: реклама в процентах от суммы заказов. ДРР = затраты ÷ сумма заказов × 100%. В отчёте WB — «Доля затрат».', act: 'ДРР выше потолка (прибыль с заказа в % от цены) — реклама в минус.' },
    ROAS: { text: 'Окупаемость рекламы: сколько рублей заказов на 1 рубль рекламы. ROAS = сумма заказов ÷ затраты = 100 ÷ ДРР.', act: 'То же, что ДРР, только наоборот: больше — лучше.' },
    'Позиция': { text: 'Место карточки в выдаче по рекламным запросам. API WB для рекламы его не отдаёт — смотрите в кабинете.', act: '' },
    'Ставка': { text: 'Сколько вы готовы платить за клик (или за 1000 показов). Списывается обычно меньше — по второй цене.', act: '' },
    'Безубыточная ставка': { text: 'Ставка, при которой вся прибыль с заказа уходит в рекламу. Выше — каждый заказ в минус.', act: '' },
    'Переходы': { text: 'Сколько раз открыли карточку товара (из поиска, каталога, рекламы).', act: '' },
    '→ корзина': { text: 'Из открывших карточку — сколько положили в корзину, %.', act: '' },
    '→ заказ': { text: 'Из положивших в корзину — сколько заказали, %.', act: '' },
    'Выкуп': { text: 'Доля заказов, которые покупатели забрали и оплатили.', act: '' },
  };
  const term = (key, label = key) => {
    const t = TERMS[key];
    if (!t) return esc(label);
    return `<span class="term" tabindex="0" data-tip="${esc(t.text + (t.act ? ` Что делать: ${t.act}` : ''))}">${esc(label)}</span>`;
  };

  const COLORS = { open: '#2f6fd6', cart: '#d69a00', orders: '#7b2cbf', buyouts: '#2e9e5b', spend: '#d64545', grey: '#a8a4b0', plan: '#a8a4b0' };
  const state = { strategies: null, overview: null };

  // ---------- Утилиты ----------
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const n = (v, d = 0) => (v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: 0 }));
  const rub = (v) => (v == null ? '—' : `${n(v)} ₽`);
  const pct = (v, d = 1) => (v == null ? '—' : `${n(v, d)}%`);
  const shortTitle = (t, vc) => {
    if (!t) return vc || '';
    return t.replace('Чайная паста', '').replace(/\s+/g, ' ').trim();
  };
  const delta = (v) => (v == null ? '' : `<span class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '▲' : '▼'} ${Math.abs(v)}%</span>`);

  async function api(path, opts = {}) {
    const res = await fetch(`api/${path}`, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'wb-funnel', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401 && path !== 'login') {
      showLogin('Время доступа закончилось. Откройте инструмент заново через админку → «Менеджмент».');
      throw new Error('Нужно войти');
    }
    if (opts.raw) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `Ошибка ${res.status}`);
    return data;
  }

  let toastTimer;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
  }

  function setActiveTab(name) {
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
  }

  function applyWidths(root) {
    root.querySelectorAll('[data-w]').forEach((e) => (e.style.width = `${Math.max(0, Math.min(100, Number(e.dataset.w)))}%`));
  }

  // ---------- Вход (через «Менеджмент» админки) ----------
  // Админка после ввода PIN открывает инструмент по адресу …/#t=ТОКЕН.
  // Токен сразу обмениваем на сессию инструмента и убираем из адресной строки.
  function takeTokenFromUrl() {
    const m = location.hash.match(/(?:^#|&)t=([^&]+)/);
    if (!m) return null;
    history.replaceState(null, '', `${location.pathname}${location.search}#/`);
    return decodeURIComponent(m[1]);
  }

  function showLogin(message) {
    document.getElementById('topbar').classList.add('hidden');
    $app.innerHTML = `
      <div class="login">
        <h2>WB Воронка</h2>
        <p>${esc(message || 'Доступ закрыт. Откройте инструмент через админку → «Менеджмент» (ввод PIN) → карточка «Воронка продаж WB».')}</p>
        <p><a class="btn" href="/admin/management">Открыть «Менеджмент»</a></p>
        <p class="small muted">Доступ действует 60 минут после ввода PIN, как у остальных инструментов «Менеджмента».</p>
      </div>`;
  }

  // ---------- Верхняя панель ----------
  async function refreshSyncStatus() {
    try {
      const s = await api('sync');
      const last = s.runs[0];
      const el = document.getElementById('syncStatus');
      if (s.running) el.textContent = 'Идёт сбор данных…';
      else if (last) {
        const when = new Date(last.finished_at || last.started_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        const bad = last.details.filter((d) => !d.ok).length;
        el.textContent = `Обновлено ${when}${bad ? ` · ошибок: ${bad}` : ''}`;
      } else el.textContent = 'Данных ещё нет';
      document.getElementById('btnSync').disabled = s.running;
      if (s.running) setTimeout(refreshSyncStatus, 8000);
    } catch {
      /* нет доступа — покажется вход */
    }
  }

  document.getElementById('btnSync').addEventListener('click', async () => {
    try {
      await api('sync', { method: 'POST', body: { kind: 'quick' } });
      toast('Сбор данных запущен. Из-за лимитов WB это займёт 2–5 минут.');
      refreshSyncStatus();
    } catch (err) {
      toast(err.message);
    }
  });
  document.getElementById('btnClaude').addEventListener('click', async () => {
    try {
      const res = await api('export/claude', { raw: true });
      const text = await res.text();
      try {
        await navigator.clipboard.writeText(text);
        toast('Сводка скопирована. Вставьте её в чат с Claude.');
      } catch {
        showTextModal(text);
      }
    } catch (err) {
      toast(err.message);
    }
  });
  document.getElementById('btnLogout').addEventListener('click', async () => {
    await api('logout', { method: 'POST' }).catch(() => {});
    showLogin('Вы вышли. Чтобы вернуться, откройте инструмент через админку → «Менеджмент».');
  });

  function showTextModal(text) {
    $app.insertAdjacentHTML('afterbegin', `<div class="panel" id="exportBox"><h3>Сводка для Claude</h3><p class="muted">Скопируйте текст ниже и вставьте в чат.</p><textarea id="exportText" rows="14"></textarea></div>`);
    const ta = document.getElementById('exportText');
    ta.value = text;
    ta.select();
  }

  // ---------- Маршрутизация ----------
  async function route() {
    const hash = location.hash || '#/';
    const [path, query] = hash.slice(1).split('?');
    const params = new URLSearchParams(query || '');
    const parts = path.split('/').filter(Boolean);
    try {
      if (parts[0] === 'product' && parts[1]) return await viewProduct(Number(parts[1]));
      if (parts[0] === 'strategies') return await viewStrategies(params);
      if (parts[0] === 'ads') return await viewAds(params);
      if (parts[0] === 'journal') return await viewJournal();
      if (parts[0] === 'settings') return await viewSettings();
      return await viewSummary();
    } catch (err) {
      if (err.message !== 'Нужно войти') $app.innerHTML = `<div class="panel"><b>Ошибка:</b> ${esc(err.message)}</div>`;
    }
  }
  window.addEventListener('hashchange', () => (/(?:^#|&)t=/.test(location.hash) ? boot() : route()));

  // ---------- Сводка ----------
  async function viewSummary() {
    setActiveTab('summary');
    $app.innerHTML = '<p class="muted">Загрузка…</p>';
    const data = await api('overview');
    state.overview = data;
    document.getElementById('mockBanner').classList.toggle('hidden', !data.mock);
    const ps = data.products;
    const sum = (f) => ps.reduce((s, p) => s + (f(p) || 0), 0);
    const cur = { open: sum((p) => p.week.open), orders: sum((p) => p.week.orders), orderSum: sum((p) => p.week.orderSum), spend: sum((p) => p.week.ads.spend), buyouts: sum((p) => p.week.buyouts) };
    const prev = { open: sum((p) => p.prevWeek.open), orders: sum((p) => p.prevWeek.orders), orderSum: sum((p) => p.prevWeek.orderSum) };
    const ch = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
    const profitKnown = ps.filter((p) => p.weekProfit != null);
    const profit = profitKnown.length ? sum((p) => p.weekProfit) : null;
    const drr = cur.spend > 0 && cur.orderSum ? (cur.spend / cur.orderSum) * 100 : null;
    const alerts = ps.flatMap((p) => p.alerts.filter((a) => a.level !== 'info').map((a) => ({ ...a, p })));
    alerts.sort((a, b) => (a.level === 'critical' ? -1 : 1) - (b.level === 'critical' ? -1 : 1));
    const noCost = ps.filter((p) => p.unit.cost == null).length;
    const hasData = ps.some((p) => p.week.days > 0);

    $app.innerHTML = `
      <h1>Сводка за 7 дней</h1>
      <p class="muted">По ${ps.length} артикулам · сравнение с предыдущими 7 днями · на ${esc(data.today)}</p>
      ${hasData ? '' : '<div class="warn">Данных пока нет. Нажмите «Обновить данные» вверху — первый сбор займёт несколько минут.</div>'}
      <div class="kpis">
        <div class="kpi"><div class="label">Переходы в карточки</div><div class="value">${n(cur.open)}</div><div class="delta">${delta(ch(cur.open, prev.open))}</div></div>
        <div class="kpi"><div class="label">Заказы, шт.</div><div class="value">${n(cur.orders)}</div><div class="delta">${delta(ch(cur.orders, prev.orders))}</div></div>
        <div class="kpi"><div class="label">Заказы, ₽</div><div class="value">${rub(cur.orderSum)}</div><div class="delta">${delta(ch(cur.orderSum, prev.orderSum))}</div></div>
        <div class="kpi"><div class="label">Реклама, ₽</div><div class="value">${rub(cur.spend)}</div><div class="delta muted">ДРР ${pct(drr)}</div></div>
        <div class="kpi"><div class="label">Ожидаемая прибыль после рекламы</div><div class="value">${profit == null ? '—' : rub(profit)}</div><div class="delta muted">${noCost ? `нет себестоимости у ${noCost} арт.` : 'по всем артикулам'}</div></div>
      </div>
      <div class="panel">
        <h2>Что требует внимания</h2>
        ${alerts.length ? `<ul class="alerts">${alerts.slice(0, 12).map((a) => `<li class="${a.level}"><b>${esc(shortTitle(a.p.title, a.p.vendorCode))}</b> — ${esc(a.text)}</li>`).join('')}</ul>` : '<p class="muted">Всё спокойно.</p>'}
      </div>
      <div class="panel">
        <h2>Артикулы</h2>
        <div class="table-wrap"><table class="data">
          <thead><tr>
            <th></th><th>Товар</th><th class="num">Цена</th><th class="num">Остаток</th><th class="num">${term('Переходы')}</th><th class="num">${term('→ корзина')}</th><th class="num">${term('→ заказ')}</th>
            <th class="num">Заказы</th><th>14 дней</th><th class="num">${term('ДРР')}</th><th class="num" title="Ожидаемая: заказы × доля выкупа × прибыль с продажи − реклама">Прибыль 7 дн. (ожид.)</th><th class="num">Рейтинг</th><th>Стратегия</th>
          </tr></thead>
          <tbody>${ps
            .map(
              (p) => `<tr class="clickable" data-nm="${p.nmId}">
              <td><span class="dot ${p.status}"></span></td>
              <td><div class="trunc">${esc(shortTitle(p.title, p.vendorCode))}</div><div class="small muted">${p.nmId}</div></td>
              <td class="num">${rub(p.snapshot.seller_price)}</td>
              <td class="num">${n(p.snapshot.stocks_wb)}<div class="small muted">${p.stockDays != null ? `~${p.stockDays} дн.` : ''}</div></td>
              <td class="num">${n(p.week.open)}<div class="small">${delta(p.changes.open)}</div></td>
              <td class="num">${pct(p.week.cartConv)}</td>
              <td class="num">${pct(p.week.orderConv)}</td>
              <td class="num">${n(p.week.orders)}<div class="small">${delta(p.changes.orders)}</div></td>
              <td>${C.spark(p.sparkOrders)}</td>
              <td class="num">${pct(p.week.ads.drr)}</td>
              <td class="num">${p.weekProfit == null ? '<span class="muted small">нет себест.</span>' : rub(p.weekProfit)}</td>
              <td class="num">${p.snapshot.feedback_rating ? n(p.snapshot.feedback_rating, 1) : '—'}</td>
              <td>${p.activePlan ? `<span class="tag">${esc(p.activePlan.title)}</span>` : ''}${(p.campaigns || []).map((c) => `<a class="tag ${c.status === 9 ? 'green' : 'grey'}" href="#/ads?c=${c.advertId}" title="${esc(c.name)}">Реклама: ${c.paymentType === 'cpm' ? 'показы' : 'клики'}${c.bid != null ? `, ${n(c.bid, 1)} ₽` : ''}${c.status === 11 ? ' (пауза)' : c.status === 4 ? ' (не запущена)' : ''}</a>`).join(' ')}${!p.activePlan && !(p.campaigns || []).length ? '<span class="tag grey">нет</span>' : ''}</td>
            </tr>`,
            )
            .join('')}</tbody>
        </table></div>
        <p class="small muted">Органических показов и общего CTR в API WB нет — воронка начинается с переходов в карточку. Показы и CTR есть по рекламе на странице товара.</p>
      </div>`;
    $app.querySelectorAll('tr[data-nm]').forEach((tr) => tr.addEventListener('click', () => (location.hash = `#/product/${tr.dataset.nm}`)));
  }

  // ---------- Товар ----------
  async function viewProduct(nmId) {
    setActiveTab('summary');
    $app.innerHTML = '<p class="muted">Загрузка…</p>';
    const d = await api(`products/${nmId}?days=30`);
    const s = d.summary;
    const w = s.week;
    const labels = d.series.map((x) => x.date);
    const markers = d.journal
      .map((j) => ({ index: labels.indexOf(j.date), text: `${j.date}: ${j.text}` }))
      .filter((m) => m.index >= 0);
    const u = s.unit;
    const funnelSteps = [
      ['Переходы в карточку', w.open, COLORS.open],
      ['Положили в корзину', w.cart, COLORS.cart],
      ['Заказали', w.orders, COLORS.orders],
      ['Выкупили', w.buyouts, COLORS.buyouts],
    ];
    const fmax = Math.max(1, w.open);
    const funnelHtml = funnelSteps
      .map(
        ([label, v, color], i) => `
        ${i > 0 ? `<div class="conv">${i === 1 ? `конверсия ${pct(w.cartConv)}` : i === 2 ? `конверсия ${pct(w.orderConv)}` : `выкуп ${pct(w.buyoutPct, 0)}`}</div>` : ''}
        <div class="step"><div>${label}</div><svg viewBox="0 0 100 10" preserveAspectRatio="none" height="18" width="100%"><rect x="0" y="0" height="10" width="${Math.max(0.5, (v / fmax) * 100)}" fill="${color}" rx="1"/></svg><div class="num"><b>${n(v)}</b></div></div>`,
      )
      .join('');

    $app.innerHTML = `
      <p><a href="#/">← Сводка</a></p>
      <h1>${esc(s.title || s.vendorCode || nmId)}</h1>
      <p class="muted">Артикул WB <a href="https://www.wildberries.ru/catalog/${nmId}/detail.aspx" target="_blank" rel="noopener">${nmId}</a> · ${esc(s.vendorCode || '')} · <span class="dot ${s.status}"></span></p>
      <div class="kpis">
        <div class="kpi"><div class="label">Цена продавца</div><div class="value">${rub(s.snapshot.seller_price)}</div><div class="delta muted">до скидки ${rub(s.snapshot.price)} · скидка ${pct(s.snapshot.discount_pct, 0)}</div></div>
        <div class="kpi"><div class="label">Остаток на WB</div><div class="value">${n(s.snapshot.stocks_wb)}</div><div class="delta muted">${s.stockDays != null ? `хватит ~${s.stockDays} дн.` : ''}</div></div>
        <div class="kpi"><div class="label">Заказы за 7 дней</div><div class="value">${n(w.orders)}</div><div class="delta">${delta(s.changes.orders)}</div></div>
        <div class="kpi"><div class="label">Прибыль с продажи</div><div class="value">${rub(u.profitPerUnit)}</div><div class="delta muted">до рекламы</div></div>
        <div class="kpi"><div class="label">Рейтинг</div><div class="value">${s.snapshot.feedback_rating ? n(s.snapshot.feedback_rating, 1) : '—'}</div><div class="delta muted">отзывов в базе: ${n(s.feedbacks.total)}</div></div>
      </div>
      <div class="grid two">
        <div class="panel"><h2>Воронка за 7 дней</h2><div class="funnel">${funnelHtml}</div>
          <p class="small muted">Реклама за 7 дней: показы ${n(w.ads.views)}, клики ${n(w.ads.clicks)}, CTR ${pct(w.ads.ctr, 2)}, клик ${rub(w.ads.cpc)}, заказ через рекламу ${rub(w.ads.cpo)}, расход ${rub(w.ads.spend)}, ДРР ${pct(w.ads.drr)}.</p>
          ${(s.campaigns || []).length ? `<p>${s.campaigns.map((c) => `<a class="btn ghost small" href="#/ads?c=${c.advertId}">Реклама «${esc(c.name)}»: прогноз и факт →</a>`).join(' ')}</p>` : ''}
        </div>
        <div class="panel"><h2>Что требует внимания</h2>
          ${s.alerts.length ? `<ul class="alerts">${s.alerts.map((a) => `<li class="${a.level}">${esc(a.text)}</li>`).join('')}</ul>` : '<p class="muted">Всё спокойно.</p>'}
          <p><a class="btn" href="#/strategies?nm=${nmId}">Подобрать стратегию</a></p>
        </div>
      </div>
      <div class="panel"><h2>Переходы и заказы по дням</h2><div id="chFunnel"></div><p class="small muted">Фиолетовые отметки — записи из журнала действий (наведите на точку).</p></div>
      <div class="grid two">
        <div class="panel"><h2>Конверсии, %</h2><div id="chConv"></div></div>
        <div class="panel"><h2>Реклама</h2><div id="chAds"></div></div>
      </div>
      <div class="grid two">
        <div class="panel"><h2>Юнит-экономика</h2>
          <div class="kv">
            <div>Цена продавца</div><div class="num">${rub(u.price)}</div>
            <div>Себестоимость</div><div class="num">${u.cost == null ? '<span class="muted">не указана</span>' : `${n(u.cost, 2)} ₽`}</div>
            <div>Комиссия WB</div><div class="num">${pct(u.commissionPct)}</div>
            <div>Логистика на продажу</div><div class="num">${rub(u.logisticsPerSold)}</div>
            <div>Хранение и приёмка на продажу</div><div class="num">${rub(u.storagePerSold)}</div>
            <div><b>Прибыль с продажи до рекламы</b></div><div class="num"><b>${rub(u.profitPerUnit)}</b></div>
            <div>Цена безубыточности</div><div class="num">${rub(u.breakEvenPrice)}</div>
            <div>Предельная реклама на продажу</div><div class="num">${rub(u.maxAdPerSale)}</div>
            <div>Рабочая реклама на продажу</div><div class="num">${rub(u.workAdPerSale)}</div>
          </div>
          <p class="small muted">${u.source === 'finance' ? 'Комиссия и логистика — фактические, из финотчёта WB за 30 дней.' : 'Комиссия и логистика — из настроек (финотчёта по товару ещё нет).'}</p>
          ${
            s.costSource === 'sheet'
              ? `<p class="small muted">Себестоимость — из таблицы «Финансы V3», лист «Себестоимость». Изменить: <a href="/management/costs/" target="_blank" rel="noopener">Менеджмент → Себестоимость</a>.</p>`
              : `<form class="form-row" id="costForm"><label>Себестоимость, ₽<br/><input type="number" min="0" step="0.01" id="costInput" value="${s.cost ?? ''}" /></label><button class="btn small" type="submit">Сохранить</button></form><p class="small muted">Артикула нет в таблице себестоимости — можно указать вручную.</p>`
          }
        </div>
        <div class="panel"><h2>Цена и остатки</h2><div id="chStock"></div></div>
      </div>
      <div class="grid two">
        <div class="panel"><h2>Поисковые запросы</h2>${renderSearch(d.search)}</div>
        <div class="panel"><h2>Последние отзывы</h2>${
          d.feedbacks.length
            ? d.feedbacks
                .slice(0, 8)
                .map(
                  (f) => `<div class="feedback"><span class="stars">${'★'.repeat(f.rating || 0)}</span> <span class="small muted">${esc(String(f.created_at || '').slice(0, 10))} ${f.answered ? '' : '· <b class="down">без ответа</b>'}</span><p>${esc(f.text || f.cons || f.pros || '(только оценка)')}</p></div>`,
                )
                .join('')
            : '<p class="empty">Отзывов в базе пока нет (собираются раз в сутки).</p>'
        }</div>
      </div>
      <div class="grid two">
        <div class="panel"><h2>Стратегии по товару</h2>${
          d.plans.length
            ? `<table class="data"><tbody>${d.plans.map((p) => `<tr><td>${esc(p.title)}</td><td>${statusTag(p.status)}</td><td class="small muted">${esc(p.start_date || '')}</td></tr>`).join('')}</tbody></table>`
            : '<p class="empty">Пока нет. Выберите стратегию на вкладке «Стратегии».</p>'
        }</div>
        <div class="panel"><h2>Журнал действий</h2>
          <form class="form-row" id="jForm"><input type="date" id="jDate" value="${esc(todayStr())}" /><input class="grow" id="jText" placeholder="Что сделали: сменили фото, цену, запустили рекламу…" /><button class="btn small" type="submit">Добавить</button></form>
          ${d.journal.filter((j) => j.nm_id === nmId).length ? `<ul class="plain">${d.journal.filter((j) => j.nm_id === nmId).slice(0, 10).map((j) => `<li><span class="muted">${esc(j.date)}</span> ${esc(j.text)}</li>`).join('')}</ul>` : '<p class="empty">Записей нет.</p>'}
        </div>
      </div>`;

    C.line(document.getElementById('chFunnel'), {
      labels,
      markers,
      series: [
        { name: 'Переходы', values: d.series.map((x) => x.open), color: COLORS.open },
        { name: 'Заказы', values: d.series.map((x) => x.orders), color: COLORS.orders, axis: 'right' },
      ],
    });
    C.line(document.getElementById('chConv'), {
      labels,
      markers,
      height: 200,
      series: [
        { name: 'В корзину', values: d.series.map((x) => x.cartConv), color: COLORS.cart },
        { name: 'В заказ', values: d.series.map((x) => x.orderConv), color: COLORS.orders },
      ],
    });
    C.bars(document.getElementById('chAds'), {
      labels,
      height: 200,
      series: [
        { name: 'Расход, ₽', values: d.series.map((x) => x.adSpend), color: COLORS.spend },
        { name: 'Клики', values: d.series.map((x) => x.adClicks), color: COLORS.open },
      ],
    });
    C.line(document.getElementById('chStock'), {
      labels,
      height: 200,
      series: [
        { name: 'Цена продавца, ₽', values: d.series.map((x) => x.price), color: COLORS.orders },
        { name: 'Остаток, шт.', values: d.series.map((x) => x.stocks), color: COLORS.buyouts, axis: 'right' },
      ],
    });
    document.getElementById('costForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`products/${nmId}`, { method: 'PUT', body: { cost_per_unit: document.getElementById('costInput').value } });
        toast('Себестоимость сохранена');
        viewProduct(nmId);
      } catch (err) {
        toast(err.message);
      }
    });
    document.getElementById('jForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('journal', { method: 'POST', body: { nmId, date: document.getElementById('jDate').value, text: document.getElementById('jText').value } });
        viewProduct(nmId);
      } catch (err) {
        toast(err.message);
      }
    });
  }

  function renderSearch(search) {
    if (!search) return '<p class="empty">Нет данных. Позиции и поисковые запросы WB отдаёт только с подпиской «Джем».</p>';
    return `<p class="small muted">За ${esc(search.date)} · средняя позиция ${n(search.avgPosition, 1)} · видимость ${pct(search.visibility, 0)}</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Запрос</th><th class="num">Частота</th><th class="num">Позиция</th><th class="num">Переходы</th><th class="num">Заказы</th></tr></thead>
      <tbody>${search.queries.slice(0, 12).map((q) => `<tr><td>${esc(q.text)}</td><td class="num">${n(q.frequency)}</td><td class="num">${n(q.avgPosition)}</td><td class="num">${n(q.openCard)}</td><td class="num">${n(q.orders)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function statusTag(s) {
    const map = { draft: ['черновик', 'grey'], active: ['идёт', 'green'], done: ['завершена', 'grey'], cancelled: ['отменена', 'grey'] };
    const [t, c] = map[s] || [s, 'grey'];
    return `<span class="tag ${c}">${t}</span>`;
  }
  function todayStr() {
    return new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  }

  // ---------- Стратегии ----------
  async function viewStrategies(params) {
    setActiveTab('strategies');
    $app.innerHTML = '<p class="muted">Загрузка…</p>';
    if (!state.strategies) state.strategies = (await api('strategies')).strategies;
    const ov = state.overview || (await api('overview'));
    state.overview = ov;
    const products = ov.products;
    const nmId = Number(params.get('nm')) || products[0]?.nmId;
    const key = params.get('s') || state.strategies[0].key;
    const strategy = state.strategies.find((x) => x.key === key) || state.strategies[0];
    const plansData = await api('plans');

    $app.innerHTML = `
      <h1>Стратегии</h1>
      <p class="muted">Выберите товар и стратегию, подвиньте параметры — справа прогноз на 30 дней в сравнении с «как сейчас». Параметры с пометкой «допущение» — наши предположения об эффекте; после запуска сверяем их с фактом.</p>
      <div class="form-row"><label>Товар<br/><select id="selNm">${products.map((p) => `<option value="${p.nmId}" ${p.nmId === nmId ? 'selected' : ''}>${esc(shortTitle(p.title, p.vendorCode))} · ${p.nmId}</option>`).join('')}</select></label>
        <button class="btn ghost" id="btnCompare" type="button">Сравнить все стратегии</button></div>
      <div id="compareBox"></div>
      <div class="grid side">
        <div class="strategy-list">${state.strategies
          .map((s) => `<div class="strategy-card ${s.key === strategy.key ? 'active' : ''}" data-key="${s.key}"><div class="stage">${esc(s.stage)}</div><div class="name">${esc(s.name)}</div><div class="small muted">${esc(s.summary)}</div></div>`)
          .join('')}</div>
        <div>
          <div class="panel">
            <h2>${esc(strategy.name)}</h2>
            <p>${esc(strategy.summary)}</p>
            <p><b>Когда применять:</b> ${esc(strategy.whenToUse)}</p>
            <div class="grid two">
              <div><h3>Шаги</h3><ul class="plain">${strategy.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
              <div><h3>Условия входа</h3><ul class="plain">${strategy.entry.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
                   <h3>Когда остановить</h3><ul class="plain">${strategy.stop.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
            </div>
            <p class="small muted"><b>Риски:</b> ${esc(strategy.risks)}</p>
            ${['ads_cpc', 'ads_cpm', 'combo'].includes(strategy.key) ? (() => {
              const camps = (products.find((p) => p.nmId === nmId)?.campaigns || []);
              return camps.length
                ? `<p class="ok-line">Сейчас по этому товару идёт реклама: ${camps.map((c) => `<a href="#/ads?c=${c.advertId}">«${esc(c.name)}»</a> (${c.paymentType === 'cpm' ? 'оплата за показы' : 'оплата за клик'}${c.bid != null ? `, ставка ${n(c.bid, 1)} ₽` : ''})`).join(', ')}. Точный разбор кампании — прогноз, факт и советы — на вкладке «Реклама».</p>`
                : '<p class="small muted">Рекламных кампаний по этому товару пока нет. Когда запустите кампанию в кабинете WB, она появится здесь и на вкладке «Реклама» после ближайшего сбора данных.</p>';
            })() : ''}
          </div>
          <div class="grid two">
            <div class="panel"><h3>Параметры</h3><div id="params">${strategy.params
              .map(
                (p) => `<div class="param ${p.kind === 'assumption' ? 'assumption' : ''}"><div class="row"><span>${esc(p.label)}</span><b><span id="v_${p.key}">${n(p.default, 2)}</span> ${esc(p.unit)}</b></div>
                <input type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.default}" data-key="${p.key}" />
                <div class="hint">${esc(p.hint)}</div></div>`,
              )
              .join('')}</div></div>
            <div class="panel"><h3>Прогноз на 30 дней</h3><div id="simResult"><p class="muted">Считаю…</p></div></div>
          </div>
          <div class="panel"><h3>Заказы по дням: как сейчас и со стратегией</h3><div id="chSim"></div>
            <div class="form-row"><input class="grow" id="planNote" placeholder="Заметка к плану (необязательно)" /><button class="btn" id="btnSavePlan" type="button">Сохранить как план</button></div>
          </div>
        </div>
      </div>
      <div class="panel"><h2>Планы</h2><div id="plansBox">${renderPlans(plansData.plans)}</div></div>`;

    const go = (nm, k) => (location.hash = `#/strategies?nm=${nm}&s=${k}`);
    document.getElementById('selNm').addEventListener('change', (e) => go(e.target.value, strategy.key));
    $app.querySelectorAll('.strategy-card').forEach((c) => c.addEventListener('click', () => go(nmId, c.dataset.key)));
    const getParams = () => Object.fromEntries([...$app.querySelectorAll('#params input[type=range]')].map((i) => [i.dataset.key, Number(i.value)]));
    let timer;
    $app.querySelectorAll('#params input[type=range]').forEach((inp) =>
      inp.addEventListener('input', () => {
        document.getElementById(`v_${inp.dataset.key}`).textContent = n(Number(inp.value), 2);
        clearTimeout(timer);
        timer = setTimeout(runSim, 250);
      }),
    );
    async function runSim() {
      try {
        const r = await api('simulate', { method: 'POST', body: { nmId, strategyKey: strategy.key, params: getParams(), days: 30 } });
        renderSim(r);
      } catch (err) {
        document.getElementById('simResult').innerHTML = `<p class="error">${esc(err.message)}</p>`;
      }
    }
    function renderSim(r) {
      const b = r.base.totals;
      const sc = r.scenario.totals;
      const row = (label, a, c, f = n, better = 'up') => {
        const diff = a != null && c != null ? c - a : null;
        const cls = diff == null || diff === 0 || better === 'none' ? '' : (diff > 0) === (better === 'up') ? 'up' : 'down';
        return `<tr><td>${label}</td><td class="num">${f(a)}</td><td class="num"><b>${f(c)}</b></td><td class="num ${cls}">${diff == null ? '' : (diff > 0 ? '+' : '') + f(diff)}</td></tr>`;
      };
      document.getElementById('simResult').innerHTML = `
        ${r.warnings.map((w) => `<div class="warn small">${esc(w)}</div>`).join('')}
        <table class="compare"><thead><tr><th></th><th class="num">Как сейчас</th><th class="num">Со стратегией</th><th class="num">Разница</th></tr></thead><tbody>
          ${row('Переходы', b.opens, sc.opens)}
          ${row('Корзины', b.carts, sc.carts)}
          ${row('Заказы', b.orders, sc.orders)}
          ${row('Выкупы', b.buyouts, sc.buyouts)}
          ${row('Цена продавца', b.price, sc.price, rub, 'none')}
          ${row('Выручка с выкупов', b.revenue, sc.revenue, rub)}
          ${row('Расходы на продвижение', b.spend, sc.spend, rub, 'down')}
          ${row('Прибыль после продвижения', b.profit, sc.profit, rub)}
          ${row('ДРР', b.drr, sc.drr, (v) => pct(v), 'down')}
        </tbody></table>
        <p class="small muted">${sc.costPerExtraOrder != null ? `Каждый дополнительный заказ обходится в ${rub(sc.costPerExtraOrder)} продвижения. ` : ''}База — средние за 14 дней: ${n(r.baseline.organicOpensPerDay, 1)} бесплатных переходов в день, конверсия в корзину ${pct(r.baseline.cartConv * 100)}, в заказ ${pct(r.baseline.orderConv * 100)}.</p>`;
      C.line(document.getElementById('chSim'), {
        labels: r.scenario.daily.map((x) => x.date || `день ${x.day}`),
        series: [
          { name: 'Как сейчас', values: r.base.daily.map((x) => x.orders), color: COLORS.grey, dashed: true },
          { name: 'Со стратегией', values: r.scenario.daily.map((x) => x.orders), color: COLORS.orders },
        ],
      });
    }
    runSim();

    document.getElementById('btnSavePlan').addEventListener('click', async () => {
      try {
        await api('plans', { method: 'POST', body: { nmId, strategyKey: strategy.key, params: getParams(), note: document.getElementById('planNote').value } });
        toast('План сохранён как черновик. Запустите его, когда начнёте действовать.');
        const pd = await api('plans');
        document.getElementById('plansBox').innerHTML = renderPlans(pd.plans);
        bindPlans();
      } catch (err) {
        toast(err.message);
      }
    });
    document.getElementById('btnCompare').addEventListener('click', async () => {
      const box = document.getElementById('compareBox');
      box.innerHTML = '<p class="muted">Считаю…</p>';
      try {
        const r = await api('compare', { method: 'POST', body: { nmId, days: 30 } });
        const base = r.results[0]?.base;
        box.innerHTML = `<div class="panel"><h3>Все стратегии с параметрами по умолчанию, 30 дней</h3><div class="table-wrap"><table class="data"><thead><tr><th>Стратегия</th><th class="num">Заказы</th><th class="num">Выкупы</th><th class="num">Расходы</th><th class="num">Прибыль</th><th class="num">ДРР</th><th class="num">Цена доп. заказа</th></tr></thead><tbody>
          <tr><td class="muted">Как сейчас</td><td class="num">${n(base?.orders)}</td><td class="num">${n(base?.buyouts)}</td><td class="num">${rub(base?.spend)}</td><td class="num">${rub(base?.profit)}</td><td class="num">${pct(base?.drr)}</td><td></td></tr>
          ${r.results.map((x) => `<tr class="clickable" data-key="${x.key}"><td>${esc(x.name)}</td><td class="num">${n(x.totals.orders)}</td><td class="num">${n(x.totals.buyouts)}</td><td class="num">${rub(x.totals.spend)}</td><td class="num"><b>${rub(x.totals.profit)}</b></td><td class="num">${pct(x.totals.drr)}</td><td class="num">${rub(x.totals.costPerExtraOrder)}</td></tr>`).join('')}
        </tbody></table></div><p class="small muted">Это оценка по допущениям. Нажмите на строку, чтобы открыть стратегию и подстроить параметры.</p></div>`;
        box.querySelectorAll('tr[data-key]').forEach((tr) => tr.addEventListener('click', () => go(nmId, tr.dataset.key)));
      } catch (err) {
        box.innerHTML = `<p class="error">${esc(err.message)}</p>`;
      }
    });
    bindPlans();
  }

  function renderPlans(plans) {
    if (!plans.length) return '<p class="empty">Планов пока нет. Подберите стратегию выше и нажмите «Сохранить как план».</p>';
    return `<div class="table-wrap"><table class="data"><thead><tr><th>Товар</th><th>Стратегия</th><th>Статус</th><th>Прогноз за 30 дн.</th><th>План против факта</th><th></th></tr></thead><tbody>${plans
      .map((p) => {
        const pr = p.progress;
        return `<tr>
          <td><div class="trunc">${esc(shortTitle(p.productTitle, ''))}</div><div class="small muted">${p.nmId}</div></td>
          <td>${esc(p.title)}<div class="small muted">${esc(paramText(p))}</div>${p.note ? `<div class="small">${esc(p.note)}</div>` : ''}</td>
          <td>${statusTag(p.status)}<div class="small muted">${p.startDate ? `с ${esc(p.startDate)}` : ''}</div></td>
          <td class="small">заказов ${n(p.totals?.orders)} (сейчас ${n(p.baseTotals?.orders)})<br/>прибыль ${rub(p.totals?.profit)}</td>
          <td>${pr ? `<div class="small">план ${n(pr.cumPlan)} · факт ${n(pr.cumFact)} заказов</div><div class="progress"><div data-w="${pr.progress ?? 0}"></div></div><div class="small muted">${pct(pr.progress, 0)} плана</div>` : '<span class="muted small">—</span>'}</td>
          <td>${
            p.status === 'draft'
              ? `<input type="date" class="small" data-start="${p.id}" value="${todayStr()}" /> <button class="btn small" data-act="activate" data-id="${p.id}">Запустить</button> <button class="btn small danger" data-act="delete" data-id="${p.id}">Удалить</button>`
              : p.status === 'active'
                ? `<button class="btn small ghost" data-act="done" data-id="${p.id}">Завершить</button> <button class="btn small danger" data-act="cancelled" data-id="${p.id}">Отменить</button>`
                : ''
          }</td></tr>`;
      })
      .join('')}</tbody></table></div>`;
  }

  function paramText(plan) {
    const st = (state.strategies || []).find((x) => x.key === plan.strategyKey);
    return Object.entries(plan.params)
      .map(([k, v]) => {
        const def = st?.params.find((x) => x.key === k);
        return def ? `${def.label}: ${n(v, 2)} ${def.unit}` : `${k}: ${v}`;
      })
      .join(' · ');
  }

  function bindPlans() {
    const box = document.getElementById('plansBox');
    if (!box) return;
    applyWidths(box);
    box.querySelectorAll('button[data-act]').forEach((b) =>
      b.addEventListener('click', async () => {
        const id = b.dataset.id;
        const act = b.dataset.act;
        try {
          if (act === 'activate') {
            const start = box.querySelector(`input[data-start="${id}"]`)?.value;
            await api(`plans/${id}/activate`, { method: 'POST', body: { startDate: start } });
            toast('Стратегия запущена. Запись добавлена в журнал.');
          } else if (act === 'delete') {
            if (!confirm('Удалить черновик плана?')) return;
            await api(`plans/${id}`, { method: 'DELETE' });
          } else {
            if (!confirm(act === 'done' ? 'Отметить стратегию завершённой?' : 'Отменить стратегию?')) return;
            await api(`plans/${id}/status`, { method: 'POST', body: { status: act } });
          }
          const pd = await api('plans');
          box.innerHTML = renderPlans(pd.plans);
          bindPlans();
        } catch (err) {
          toast(err.message);
        }
      }),
    );
  }

  // ---------- Журнал ----------

  // ---------- Реклама: каждая кампания — прогноз, факт, советы, калькулятор ----------
  async function viewAds(params) {
    setActiveTab('ads');
    $app.innerHTML = '<p class="muted">Загрузка…</p>';
    const d = await api('ads');
    const focus = Number(params.get('c')) || null;
    const items = focus ? [...d.items.filter((x) => x.campaign.advertId === focus), ...d.items.filter((x) => x.campaign.advertId !== focus)] : d.items;
    if (!items.length) {
      $app.innerHTML = `<h1>Реклама</h1><div class="panel"><p>Рекламных кампаний пока не видно.</p>
        <p class="muted">Кампании подтягиваются из кабинета WB при каждом сборе данных (раз в 3 часа или по кнопке «Обновить данные»). Нужна категория токена «Продвижение».
        Товары с действующей рекламой отслеживаются автоматически, даже без галочки «Воронка WB».</p></div>`;
      return;
    }
    const r1 = (v, dgt = 1) => n(v, dgt);
    const bidUnit = (c) => (c.paymentType === 'cpm' ? '₽ за 1000 показов' : '₽ за клик');
    const levelCls = { critical: 'critical', warning: 'warning', info: 'info', good: 'good' };

    const econTable = (it) => {
      const u = it.unit;
      const i = it.inputs;
      const e = it.economics;
      return `
        <table class="data compact"><tbody>
          <tr><td>Цена продажи (ваша, после скидки)</td><td class="num">${rub(i.price)}</td></tr>
          <tr><td>Комиссия WB ${pct(u.commissionPct)} <span class="small muted">(${esc(u.commissionSource)})</span></td><td class="num">−${rub(i.price != null ? (i.price * u.commissionPct) / 100 : null)}</td></tr>
          <tr><td>Эквайринг ${pct(u.acquiringPct)} и налог ${pct(u.taxPct)} <span class="small muted">(настройки)</span></td><td class="num">−${rub(i.price != null ? (i.price * (u.acquiringPct + u.taxPct)) / 100 : null)}</td></tr>
          <tr><td>Логистика на проданную штуку <span class="small muted">(${esc(u.logisticsSource)}, с учётом невыкупов)</span></td><td class="num">−${rub(u.logisticsPerSold)}</td></tr>
          <tr><td>Хранение и приёмка</td><td class="num">−${rub(u.storagePerSold)}</td></tr>
          <tr><td>Себестоимость <span class="small muted">(«Финансы V3»)</span></td><td class="num">${u.cost != null ? `−${rub(u.cost)}` : '<span class="bad">не указана</span>'}</td></tr>
          <tr class="total"><td>Прибыль с продажи до рекламы</td><td class="num"><b>${rub(u.profitPerUnit)}</b></td></tr>
          <tr><td>× выкуп ${pct(u.buyoutPct, 0)} = <b>прибыль с заказа до рекламы</b></td><td class="num"><b>${rub(e.profitPerOrder)}</b></td></tr>
          <tr><td>Это потолок ДРР: реклама дороже — в минус</td><td class="num">${pct(e.breakEvenDrrPct)}</td></tr>
        </tbody></table>`;
    };

    const clickTable = (it) => {
      const i = it.inputs;
      const e = it.economics;
      const c = it.campaign;
      const rec = it.recommended;
      return `
        <table class="data compact"><tbody>
          <tr><td>${term('Ставка', 'Ставка в кабинете')}</td><td class="num">${r1(i.bid)} ${bidUnit(c)}</td></tr>
          <tr><td>${term('CPC', 'Цена клика (CPC)')} <span class="small muted">(${esc(i.chargeSource)}${c.paymentType === 'cpm' ? `; CTR ${pct(i.ctr * 100, 2)} — ${esc(i.ctrSource)}` : ''})</span></td><td class="num">${r1(e.cpc, 2)} ₽</td></tr>
          <tr><td>${term('CR', 'Конверсия клика в заказ (CR)')} <span class="small muted">(${esc(i.crSource)})</span></td><td class="num">${pct(e.cr, 2)}</td></tr>
          <tr><td>${term('CPO', 'Заказ с рекламы стоит (CPO)')} <span class="small muted">(цена клика ÷ конверсия)</span></td><td class="num">${rub(e.costPerOrder)}</td></tr>
          <tr><td>${term('ДРР')} <span class="small muted">(цена клика ÷ (конверсия × цена))</span></td><td class="num"><b>${pct(e.drrPct)}</b> <span class="small muted">цель ${pct(d.targetDrrPct, 0)}</span></td></tr>
          <tr><td>Прибыль с заказа после рекламы</td><td class="num"><b class="${e.profitPerOrderAfterAds != null && e.profitPerOrderAfterAds < 0 ? 'bad' : ''}">${rub(e.profitPerOrderAfterAds)}</b> <span class="small muted">маржа ${pct(e.marginAfterAdsPct)}</span></td></tr>
          <tr><td>${term('Безубыточная ставка')} <span class="small muted">(выше — каждый заказ в минус)</span></td><td class="num">${r1(e.breakEvenBid)} ${bidUnit(c)}</td></tr>
          <tr><td>Ставка под цель ДРР ${pct(d.targetDrrPct, 0)}</td><td class="num">${r1(e.targetBid)} ${bidUnit(c)}</td></tr>
          ${rec ? `<tr><td>Рекомендации WB <span class="small muted">(конкурентная / лидеры / топ-2)</span></td><td class="num">${r1(rec.competitive)} / ${r1(rec.leaders)} / ${r1(rec.top2)} ₽</td></tr>` : ''}
        </tbody></table>`;
    };

    const perDayLine = (p, label) => (p ? `<p><b>${label}:</b> ${n(p.clicks, 1)} кликов → ${n(p.orders, 2)} заказа → расход ${rub(p.spend)}, выручка ${rub(p.revenue)}, прибыль ${rub(p.profit)} в день · за 7 дней ≈ ${n(p.orders * 7, 1)} заказа и ${rub(p.profit != null ? p.profit * 7 : null)} прибыли</p>` : '<p class="muted">Объём в день не оценить: нет дневного лимита, бюджета и факта кликов.</p>');

    const compareTable = (it) => {
      if (!it.forecast) return '<p class="muted">Прогноз появится при ближайшем сборе данных.</p>';
      const cmp = it.comparison;
      const head = `<p class="small muted">Прогноз от ${esc(String(it.forecast.createdAt).slice(0, 10))}: ${esc(it.forecast.reason || '')}. Факт — в среднем за день с этой даты (${n(it.factSinceForecast?.days)} дн.).</p>`;
      if (!cmp) return head + '<p class="muted">Факта после прогноза пока нет — сравнение появится после первых показов.</p>';
      return head + `<table class="data compact"><thead><tr><th></th><th class="num">Прогноз</th><th class="num">Факт</th><th class="num">Разница</th></tr></thead><tbody>
        ${cmp.map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${n(r.plan, 2)}${r.unit ? ` ${r.unit}` : ''}</td><td class="num">${n(r.fact, 2)}${r.unit ? ` ${r.unit}` : ''}</td><td class="num ${r.good === false ? 'bad' : r.good ? 'good' : ''}">${r.deltaPct == null ? '—' : `${r.deltaPct > 0 ? '+' : ''}${r.deltaPct}%`}</td></tr>`).join('')}
      </tbody></table>`;
    };

    const scenarioTable = (rows, c) => `<table class="data compact"><thead><tr><th class="num">Ставка</th><th class="num">${term('CPC', 'Цена клика')}</th><th class="num">Клики/день</th><th class="num">Заказы/день</th><th class="num">Расход/день</th><th class="num">${term('ДРР')}</th><th class="num">Прибыль с заказа</th><th class="num">Прибыль/день</th></tr></thead><tbody>
      ${rows.map((s) => `<tr class="${s.current ? 'current' : ''}"><td class="num">${n(s.bid, 1)} ₽${s.current ? ' · сейчас' : ''}</td><td class="num">${n(s.cpc, 2)} ₽</td><td class="num">${n(s.perDay?.clicks, 1)}</td><td class="num">${n(s.perDay?.orders, 2)}</td><td class="num">${rub(s.perDay?.spend)}</td><td class="num ${s.drrPct != null && s.drrPct > d.targetDrrPct ? 'bad' : ''}">${pct(s.drrPct)}</td><td class="num ${s.profitPerOrderAfterAds != null && s.profitPerOrderAfterAds < 0 ? 'bad' : ''}">${rub(s.profitPerOrderAfterAds)}</td><td class="num">${rub(s.perDay?.profit)}</td></tr>`).join('')}
      </tbody></table><p class="small muted">Ставка — ${bidUnit(c)}. Клики при другой ставке — допущение: растут медленнее ставки (×2 ставка ≈ ×1,6 кликов) и не больше дневного бюджета. Конверсия и цена — как сейчас.</p>`;

    $app.innerHTML = `
      <h1>Реклама</h1>
      <p class="muted">По каждой кампании WB: из чего складывается прибыль, сколько стоит клик и заказ, прогноз при запуске и факт, что поменять. Расчёт по формулам юнит-экономики; комиссия — тариф WB по предмету или финотчёт, логистика — финотчёт или настройки. Допущения подписаны.</p>
      ${items.map((it, idx) => {
        const c = it.campaign;
        const f = it.fact;
        return `
        <section class="panel ad-card" data-idx="${idx}">
          <div class="ad-head">
            <div>
              <h2>${esc(shortTitle(it.product.title, it.product.vendorCode) || it.nmId)}</h2>
              <p class="muted">«${esc(c.name)}» · ${esc(c.paymentLabel)} · <span class="tag ${c.status === 9 ? 'green' : 'grey'}">${esc(c.statusLabel)}</span>
                ${c.placements ? ` · ${[c.placements.search ? 'поиск' : '', c.placements.recommendations ? 'рекомендации' : ''].filter(Boolean).join(' и ')}` : ''}
                · создана ${c.createdAt ? esc(String(c.createdAt).slice(0, 10)) : '—'} · <a href="#/product/${it.nmId}">товар ${it.nmId}</a></p>
            </div>
            <div class="ad-kpis">
              <div><span class="muted small">Бюджет кампании</span><b>${rub(c.budgetTotal)}</b></div>
              <div><span class="muted small">Дневной лимит</span><b>${c.dailyLimit ? rub(c.dailyLimit) : 'нет'}</b></div>
              <div><span class="muted small">Остаток на WB</span><b>${n(it.product.stocks)}${it.product.stockDays != null ? ` · ~${it.product.stockDays} дн.` : ''}</b></div>
            </div>
          </div>
          <div class="metrics">
            <div class="metric"><div class="label">${term('Показы')}</div><div class="value">${n(f.views)}</div></div>
            <div class="metric"><div class="label">${term('Клики')}</div><div class="value">${n(f.clicks)}</div></div>
            <div class="metric"><div class="label">${term('CTR')}</div><div class="value">${pct(f.ctr, 2)}</div></div>
            <div class="metric"><div class="label">${term('CPC')}</div><div class="value">${f.cpc != null ? `${n(f.cpc, 2)} ₽` : '—'}</div></div>
            <div class="metric"><div class="label">${term('CPM')}</div><div class="value">${rub(f.cpm)}</div></div>
            <div class="metric"><div class="label">${term('Корзины')}</div><div class="value">${n(f.atbs)}</div></div>
            <div class="metric"><div class="label">${term('Заказы')}</div><div class="value">${n(f.orders)}</div>${f.otherOrders ? `<div class="small muted">в т. ч. ${n(f.otherOrders)} другие товары</div>` : ''}</div>
            <div class="metric"><div class="label">${term('CR')}</div><div class="value">${pct(f.cr, 2)}</div></div>
            <div class="metric"><div class="label">${term('Затраты')}</div><div class="value">${rub(f.spend)}</div></div>
            <div class="metric key"><div class="label">${term('CPO')}</div><div class="value">${rub(f.costPerOrder)}</div><div class="small muted">прибыль с заказа ${rub(it.economics.profitPerOrder)}</div></div>
            <div class="metric"><div class="label">${term('Сумма заказов')}</div><div class="value">${rub(f.orderSum)}</div></div>
            <div class="metric key"><div class="label">${term('ДРР')}</div><div class="value">${pct(f.drrWbPct)}</div><div class="small muted">от вашей цены ${pct(f.drrPct)} · потолок ${pct(it.economics.breakEvenDrrPct)}</div></div>
            <div class="metric"><div class="label">${term('ROAS')}</div><div class="value">${f.roas != null ? n(f.roas, 2) : '—'}</div></div>
          </div>
          <p class="small muted">Факт с ${esc(f.from)} по ${esc(f.to)} (${n(f.days)} дн. с данными), по последнему сбору данных. WB отдаёт статистику рекламы с задержкой до нескольких часов, поэтому в кабинете цифры могут быть свежее. Заказы — как в отчёте WB: вместе с заказами других ваших товаров после клика по рекламе.</p>
          <div class="grid two">
            <div><h3>Что сделать</h3><ul class="alerts">${it.recommendations.map((r) => `<li class="${levelCls[r.level] || 'info'}">${esc(r.text)}</li>`).join('') || '<li class="info">Пока нечего советовать.</li>'}</ul>
              <h3>Прогноз и факт</h3>${compareTable(it)}
              ${it.forecastHistory.length ? `<details><summary class="small">Прежние прогнозы (${it.forecastHistory.length})</summary><ul class="plain small">${it.forecastHistory.map((h) => `<li>${esc(String(h.createdAt).slice(0, 10))}: ${esc(h.reason)} → ДРР ${pct(h.drrPct)}${h.perDay ? `, ${n(h.perDay.orders, 2)} заказа/день` : ''}</li>`).join('')}</ul></details>` : ''}
            </div>
            <div><h3>Экономика клика сейчас</h3>${clickTable(it)}
              ${perDayLine(it.economics.perDay, 'Ожидание в день при нынешних настройках')}
              <p class="small muted">Клики в день: ${esc(it.inputs.clicksSource || '—')}. Бюджет в день: ${it.inputs.dailyBudget ? `${rub(it.inputs.dailyBudget)} — ${esc(it.inputs.budgetSource)}` : 'неизвестен'}.</p>
            </div>
          </div>
          <details class="ad-more"><summary>Из чего прибыль с заказа (юнит-экономика)</summary>${econTable(it)}</details>
          <details class="ad-more" open><summary>Калькулятор: что будет, если поменять ставку или бюджет</summary>
            <div class="form-row calc">
              <label>Ставка, ${bidUnit(c)}<br/><input type="number" step="0.1" min="0" data-f="bid" value="${it.inputs.bid ?? ''}"/></label>
              <label>Бюджет в день, ₽<br/><input type="number" step="10" min="0" data-f="dailyBudget" value="${it.inputs.dailyBudget ?? ''}"/></label>
              <label>Конверсия клика в заказ, %<br/><input type="number" step="0.1" min="0" data-f="crPct" value="${it.economics.cr ?? ''}"/></label>
              ${c.paymentType === 'cpm' ? `<label>CTR, %<br/><input type="number" step="0.1" min="0" data-f="ctrPct" value="${n(it.inputs.ctr * 100, 2).replace(',', '.')}"/></label>` : ''}
              <button class="btn" type="button" data-calc="${idx}">Пересчитать</button>
            </div>
            <div class="calc-out" id="calcOut${idx}">${perDayLine(it.economics.perDay, 'Сейчас')}${scenarioTable(it.scenarios, c)}</div>
          </details>
        </section>`;
      }).join('')}
      <details class="panel glossary"><summary><b>Шпаргалка: что значат показатели рекламы</b></summary>
        <p class="small muted">Цепочка: показы → CTR → клики → CR → заказы. Затраты = клики × CPC. CPO = затраты ÷ заказы — сравнивайте с прибылью с заказа. Остальное подсказывает, где чинить.</p>
        <table class="data compact"><tbody>${['Показы', 'Клики', 'CTR', 'CPC', 'CPM', 'Корзины', 'Заказы', 'CR', 'Затраты', 'CPO', 'CPS', 'Сумма заказов', 'ДРР', 'ROAS', 'Позиция', 'Ставка', 'Безубыточная ставка']
          .map((k) => `<tr><td><b>${esc(k)}</b></td><td>${esc(TERMS[k].text)}${TERMS[k].act ? `<br/><span class="small muted">Что делать: ${esc(TERMS[k].act)}</span>` : ''}</td></tr>`).join('')}</tbody></table>
      </details>`;

    $app.querySelectorAll('[data-calc]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const idx = Number(btn.dataset.calc);
        const it = items[idx];
        const card = $app.querySelector(`.ad-card[data-idx="${idx}"]`);
        const body = { advertId: it.campaign.advertId, nmId: it.nmId };
        card.querySelectorAll('[data-f]').forEach((inp) => {
          const v = String(inp.value).trim().replace(',', '.');
          if (v !== '') body[inp.dataset.f] = Number(v);
        });
        // Не меняли ставку — не масштабируем клики
        if (body.bid === it.inputs.bid) delete body.bid;
        if (body.dailyBudget === it.inputs.dailyBudget) delete body.dailyBudget;
        if (body.crPct === it.economics.cr) delete body.crPct;
        try {
          const r = await api('ads/calc', { method: 'POST', body });
          const e = r.economics;
          document.getElementById(`calcOut${idx}`).innerHTML = `
            <p><b>При ставке ${n(r.inputs.bid, 1)} ${bidUnit(it.campaign)}:</b> цена клика ${n(e.cpc, 2)} ₽, заказ с рекламы ${rub(e.costPerOrder)}, ДРР <b>${pct(e.drrPct)}</b>, прибыль с заказа после рекламы ${rub(e.profitPerOrderAfterAds)} (маржа ${pct(e.marginAfterAdsPct)}).</p>
            ${perDayLine(e.perDay, 'В день')}
            <p class="small muted">Клики в день: ${esc(r.inputs.clicksSource || '—')}.</p>
            ${scenarioTable(r.scenarios, it.campaign)}`;
        } catch (err) {
          toast(err.message);
        }
      }),
    );
    if (focus) $app.querySelector('.ad-card')?.scrollIntoView({ block: 'start' });
  }

  async function viewJournal() {
    setActiveTab('journal');
    const [j, ov] = await Promise.all([api('journal'), state.overview ? Promise.resolve(state.overview) : api('overview')]);
    state.overview = ov;
    const kinds = { note: 'Заметка', price: 'Цена', content: 'Контент', ads: 'Реклама', stock: 'Поставка', reviews: 'Отзывы', promo: 'Акция', strategy: 'Стратегия' };
    $app.innerHTML = `
      <h1>Журнал действий</h1>
      <p class="muted">Записывайте всё, что меняете: цену, фото, рекламу, поставки. Записи показываются отметками на графиках товара — так видно, что сработало.</p>
      <div class="panel"><form id="jForm">
        <div class="form-row">
          <label>Дата<br/><input type="date" id="jDate" value="${todayStr()}" /></label>
          <label>Товар<br/><select id="jNm"><option value="">Весь магазин</option>${ov.products.map((p) => `<option value="${p.nmId}">${esc(shortTitle(p.title, p.vendorCode))}</option>`).join('')}</select></label>
          <label>Тип<br/><select id="jKind">${Object.entries(kinds).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        </div>
        <div class="form-row"><input class="grow" id="jText" placeholder="Что сделали" required /><button class="btn" type="submit">Добавить</button></div>
      </form></div>
      <div class="panel">${
        j.entries.length
          ? `<table class="data"><thead><tr><th>Дата</th><th>Товар</th><th>Тип</th><th>Что сделали</th><th></th></tr></thead><tbody>${j.entries
              .map((e) => `<tr><td class="num">${esc(e.date)}</td><td class="small">${e.nm_id ? esc(shortTitle(e.product_title, '')) : '<span class="muted">весь магазин</span>'}</td><td><span class="tag grey">${esc(kinds[e.kind] || e.kind)}</span></td><td>${esc(e.text)}</td><td><button class="btn small danger" data-del="${e.id}">×</button></td></tr>`)
              .join('')}</tbody></table>`
          : '<p class="empty">Записей пока нет.</p>'
      }</div>`;
    document.getElementById('jForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('journal', { method: 'POST', body: { date: document.getElementById('jDate').value, nmId: document.getElementById('jNm').value || null, kind: document.getElementById('jKind').value, text: document.getElementById('jText').value } });
        viewJournal();
      } catch (err) {
        toast(err.message);
      }
    });
    $app.querySelectorAll('button[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('Удалить запись?')) return;
        await api(`journal/${b.dataset.del}`, { method: 'DELETE' });
        viewJournal();
      }),
    );
  }

  // ---------- Настройки ----------
  async function viewSettings() {
    setActiveTab('settings');
    const d = await api('settings');
    const s = d.settings;
    const field = (key, label, unit, hint = '') => `<label class="param"><div class="row"><span>${label}</span><span class="muted">${unit}</span></div><input type="number" step="0.01" min="0" data-set="${key}" value="${s[key]}" />${hint ? `<div class="hint">${hint}</div>` : ''}</label>`;
    $app.innerHTML = `
      <h1>Настройки</h1>
      <div class="panel"><h2>Себестоимость товаров</h2>
        <p class="muted">Берётся автоматически из таблицы «Финансы V3», лист «Себестоимость», по артикулу продавца — при каждом обновлении данных. Менять её — в <a href="/management/costs/" target="_blank" rel="noopener">Менеджмент → Себестоимость</a>. Вручную здесь можно указать только товары, которых нет в таблице.</p>
        <table class="data"><thead><tr><th>Товар</th><th>Артикул продавца</th><th>Себестоимость, ₽</th><th>Источник</th></tr></thead><tbody>${d.products
          .map(
            (p) => `<tr><td>${esc(shortTitle(p.title, p.vendor_code))}<div class="small muted">${p.nm_id}</div></td><td class="small">${esc(p.vendor_code || '—')}</td>
            <td>${p.cost_source === 'sheet' ? `<b>${n(p.cost_per_unit, 2)} ₽</b>` : `<input type="number" min="0" step="0.01" data-cost="${p.nm_id}" value="${p.cost_per_unit ?? ''}" />`}</td>
            <td class="small">${p.cost_source === 'sheet' ? `<span class="tag green">таблица</span> <span class="muted">${p.cost_updated_at ? esc(new Date(p.cost_updated_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })) : ''}</span>` : p.cost_per_unit != null ? '<span class="tag grey">вручную</span>' : '<span class="down">нет в таблице</span>'}</td></tr>`,
          )
          .join('')}</tbody></table>
        ${d.products.some((p) => p.cost_source !== 'sheet') ? '<p><button class="btn" id="btnCosts" type="button">Сохранить себестоимость</button></p>' : ''}
      </div>
      <div class="grid two">
        <div class="panel"><h2>Юнит-экономика по умолчанию</h2>
          <p class="small muted">Используется, пока по товару нет данных финотчёта WB (тогда комиссия и логистика берутся фактические).</p>
          ${field('commissionPct', 'Комиссия WB', '%', 'Проверьте в кабинете: «Тарифы» → «Комиссия», предмет «Чай»')}
          ${field('acquiringPct', 'Эквайринг', '%')}
          ${field('taxPct', 'Налог', '% от цены')}
          ${field('logisticsPerDelivery', 'Логистика за доставку', '₽')}
          ${field('returnLogistics', 'Обратная логистика', '₽')}
          ${field('storagePerUnit', 'Хранение и приёмка на штуку', '₽')}
          ${field('defaultBuyoutPct', 'Процент выкупа', '%')}
          ${field('costPerReviewPoint', 'Стоимость 1 балла за отзыв', '₽')}
        </div>
        <div class="panel"><h2>Цели и пороги тревог</h2>
          ${field('targetDrrPct', 'Цель по ДРР', '%', 'Выше — тревога «ДРР выше цели»')}
          ${field('targetProfitPerUnit', 'Желаемая прибыль с продажи после рекламы', '₽')}
          ${field('minStockDays', 'Минимальный запас', 'дней')}
          ${field('minRating', 'Минимальный рейтинг', '★')}
          <p><button class="btn" id="btnSettings" type="button">Сохранить настройки</button></p>
        </div>
      </div>
      <div class="panel"><h2>Сбор данных из WB</h2>
        <p>${d.mock ? '<span class="tag">тестовый режим</span> ' : ''}Токен WB: ${d.tokenSet ? '<span class="tag green">задан</span>' : '<span class="tag grey">не задан</span>'} · воронка, цены, остатки и реклама обновляются автоматически каждые несколько часов, отзывы, финотчёт и поиск — раз в сутки.</p>
        <p><button class="btn ghost" id="btnQuick" type="button" ${d.syncRunning ? 'disabled' : ''}>Быстрое обновление</button> <button class="btn ghost" id="btnFull" type="button" ${d.syncRunning ? 'disabled' : ''}>Полное обновление</button></p>
        ${
          d.runs.length
            ? `<table class="data"><thead><tr><th>Начало</th><th>Тип</th><th>Итог</th><th>Шаги</th></tr></thead><tbody>${d.runs
                .map(
                  (r) => `<tr><td class="small">${esc(new Date(r.started_at).toLocaleString('ru-RU'))}</td><td>${r.kind === 'full' ? 'полный' : 'быстрый'}</td><td>${statusTagRun(r.status)}</td>
                  <td class="small">${r.details.map((x) => `${x.ok ? '✓' : '✗'} ${esc(x.label)}${x.ok ? '' : `: <span class="down">${esc(x.error)}</span>`}`).join('<br/>')}</td></tr>`,
                )
                .join('')}</tbody></table>`
            : '<p class="empty">Сбор ещё не запускался.</p>'
        }
      </div>`;
    document.getElementById('btnCosts')?.addEventListener('click', async () => {
      try {
        for (const inp of $app.querySelectorAll('input[data-cost]')) {
          await api(`products/${inp.dataset.cost}`, { method: 'PUT', body: { cost_per_unit: inp.value } });
        }
        toast('Себестоимость сохранена');
      } catch (err) {
        toast(err.message);
      }
    });
    document.getElementById('btnSettings').addEventListener('click', async () => {
      try {
        const body = Object.fromEntries([...$app.querySelectorAll('input[data-set]')].map((i) => [i.dataset.set, i.value]));
        await api('settings', { method: 'PUT', body });
        toast('Настройки сохранены');
      } catch (err) {
        toast(err.message);
      }
    });
    const sync = (kind) => async () => {
      try {
        await api('sync', { method: 'POST', body: { kind } });
        toast(kind === 'full' ? 'Полный сбор запущен — это займёт 10–15 минут из-за лимитов WB.' : 'Сбор запущен — 2–5 минут.');
        refreshSyncStatus();
        setTimeout(viewSettings, 1500);
      } catch (err) {
        toast(err.message);
      }
    };
    document.getElementById('btnQuick').addEventListener('click', sync('quick'));
    document.getElementById('btnFull').addEventListener('click', sync('full'));
  }
  function statusTagRun(s) {
    const map = { ok: ['успешно', 'green'], partial: ['частично', ''], error: ['ошибка', 'grey'], running: ['идёт', ''] };
    const [t, c] = map[s] || [s, 'grey'];
    return `<span class="tag ${c}">${t}</span>`;
  }

  // ---------- Запуск ----------
  async function boot() {
    try {
      const token = takeTokenFromUrl();
      if (token) {
        try {
          await api('login', { method: 'POST', body: { token } });
        } catch (err) {
          return showLogin(err.message);
        }
      }
      const me = await api('me');
      if (!me.authenticated) return showLogin();
      document.getElementById('topbar').classList.remove('hidden');
      document.getElementById('mockBanner').classList.toggle('hidden', !me.mock);
      refreshSyncStatus();
      route();
    } catch (err) {
      $app.innerHTML = `<div class="panel">Не удалось загрузить: ${esc(err.message)}</div>`;
    }
  }
  boot();
})();
