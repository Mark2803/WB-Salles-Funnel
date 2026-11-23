// Маленькая библиотека графиков на SVG (без внешних зависимостей).
// window.Charts.line(container, { labels, series: [{ name, values, color, axis, dashed }], markers: [{ index, text }], height })
// window.Charts.bars(container, { labels, series: [{ name, values, color }], height })
(function () {
  const NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }
  function niceMax(v) {
    if (!v || v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }
  function fmt(v) {
    if (v == null) return '';
    if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString('ru-RU');
    return String(Math.round(v * 10) / 10).replace('.', ',');
  }
  function shortDate(s) {
    if (!s || s.length < 10) return s || '';
    return `${s.slice(8, 10)}.${s.slice(5, 7)}`;
  }
  function legend(container, series) {
    const lg = document.createElement('div');
    lg.className = 'legend';
    for (const s of series) {
      const span = document.createElement('span');
      const i = document.createElement('i');
      i.style.background = s.color;
      span.appendChild(i);
      span.appendChild(document.createTextNode(s.name + (s.axis === 'right' ? ' (правая шкала)' : '')));
      lg.appendChild(span);
    }
    container.appendChild(lg);
  }

  function frame(container, height, labels) {
    container.innerHTML = '';
    const W = Math.max(320, Math.round(container.clientWidth || 760));
    const H = height || 220;
    const pad = { l: 44, r: 44, t: 12, b: 26 };
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' }, container);
    const plotW = W - pad.l - pad.r;
    const plotH = H - pad.t - pad.b;
    const n = labels.length;
    const x = (i) => pad.l + (n <= 1 ? plotW / 2 : (i * plotW) / (n - 1));
    const step = Math.max(1, Math.ceil(n / 10));
    labels.forEach((lab, i) => {
      if (i % step !== 0 && i !== n - 1) return;
      const t = el('text', { x: x(i), y: H - 8, 'text-anchor': 'middle' }, svg);
      t.textContent = shortDate(lab);
    });
    return { svg, W, H, pad, plotW, plotH, x, n };
  }

  function grid(svg, f, max, side) {
    for (let k = 0; k <= 4; k++) {
      const y = f.pad.t + f.plotH - (k / 4) * f.plotH;
      if (side === 'left') el('line', { x1: f.pad.l, x2: f.W - f.pad.r, y1: y, y2: y, stroke: '#eeeaf2' }, svg);
      const t = el('text', { x: side === 'left' ? f.pad.l - 6 : f.W - f.pad.r + 6, y: y + 4, 'text-anchor': side === 'left' ? 'end' : 'start' }, svg);
      t.textContent = fmt((max * k) / 4);
    }
  }

  function line(container, opts) {
    const labels = opts.labels || [];
    const f = frame(container, opts.height, labels);
    const left = opts.series.filter((s) => s.axis !== 'right');
    const right = opts.series.filter((s) => s.axis === 'right');
    const maxOf = (arr) => niceMax(Math.max(0, ...arr.flatMap((s) => s.values.filter((v) => v != null))));
    const maxL = maxOf(left);
    const maxR = right.length ? maxOf(right) : 1;
    grid(f.svg, f, maxL, 'left');
    if (right.length) grid(f.svg, f, maxR, 'right');
    for (const m of opts.markers || []) {
      const xx = f.x(m.index);
      el('line', { x1: xx, x2: xx, y1: f.pad.t, y2: f.pad.t + f.plotH, stroke: '#7b2cbf', 'stroke-dasharray': '3 3', 'stroke-opacity': '0.6' }, f.svg);
      const t = el('title', {}, el('circle', { cx: xx, cy: f.pad.t + 4, r: 4, fill: '#7b2cbf' }, f.svg));
      t.textContent = m.text;
    }
    for (const s of opts.series) {
      const max = s.axis === 'right' ? maxR : maxL;
      const y = (v) => f.pad.t + f.plotH - (v / max) * f.plotH;
      let d = '';
      s.values.forEach((v, i) => {
        if (v == null) return;
        d += `${d ? 'L' : 'M'}${f.x(i).toFixed(1)},${y(v).toFixed(1)} `;
      });
      if (d) el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-dasharray': s.dashed ? '5 4' : '' }, f.svg);
      s.values.forEach((v, i) => {
        if (v == null) return;
        const c = el('circle', { cx: f.x(i), cy: y(v), r: 3, fill: s.color }, f.svg);
        el('title', {}, c).textContent = `${labels[i]}: ${s.name} — ${fmt(v)}`;
      });
    }
    legend(container, opts.series);
  }

  function bars(container, opts) {
    const labels = opts.labels || [];
    const f = frame(container, opts.height, labels);
    const max = niceMax(Math.max(0, ...opts.series.flatMap((s) => s.values.filter((v) => v != null))));
    grid(f.svg, f, max, 'left');
    const groupW = f.plotW / Math.max(1, f.n);
    const bw = Math.max(2, (groupW * 0.7) / opts.series.length);
    opts.series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        if (!v) return;
        const h = (v / max) * f.plotH;
        const cx = f.pad.l + (f.n <= 1 ? f.plotW / 2 : (i * f.plotW) / (f.n - 1));
        const xx = cx - (bw * opts.series.length) / 2 + si * bw;
        const r = el('rect', { x: xx, y: f.pad.t + f.plotH - h, width: bw - 1, height: h, fill: s.color, rx: 1.5 }, f.svg);
        el('title', {}, r).textContent = `${labels[i]}: ${s.name} — ${fmt(v)}`;
      });
    });
    legend(container, opts.series);
  }

  function spark(values, color) {
    const w = 90;
    const h = 24;
    const max = Math.max(1, ...values);
    const pts = values.map((v, i) => `${((i * w) / Math.max(1, values.length - 1)).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><polyline points="${pts}" fill="none" stroke="${color || '#7b2cbf'}" stroke-width="1.6"/></svg>`;
  }

  window.Charts = { line, bars, spark, fmt };
})();
