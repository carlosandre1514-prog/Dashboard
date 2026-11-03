// NX Charts — biblioteca de gráficos SVG própria (linha, área, colunas, empilhado, rosca, barras, mapa de calor, funil, sparkline).
// Marcas finas, grade discreta, crosshair + tooltip em tudo. Rótulos vindos de dados entram via textContent.
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  };
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  // ---------------------------------------------------------- tooltip único
  let tip;
  function tooltip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'viz-tip';
    tip.setAttribute('role', 'status');
    document.body.appendChild(tip);
    return tip;
  }
  function showTip(x, y, title, rows) {
    const t = tooltip();
    t.replaceChildren();
    if (title) { const h = document.createElement('div'); h.className = 'viz-tip-h'; h.textContent = title; t.appendChild(h); }
    for (const r of rows) {
      const row = document.createElement('div'); row.className = 'viz-tip-r';
      const key = document.createElement('span'); key.className = 'viz-key ' + (r.shape || 'line'); key.style.background = r.color || 'transparent';
      const v = document.createElement('b'); v.textContent = r.value;
      const n = document.createElement('span'); n.className = 'viz-tip-n'; n.textContent = r.name;
      row.append(key, v, n); t.appendChild(row);
    }
    t.style.display = 'block';
    const w = t.offsetWidth, h = t.offsetHeight;
    let left = x + 16, top = y - h / 2;
    if (left + w > window.innerWidth - 8) left = x - w - 16;
    top = Math.max(8, Math.min(window.innerHeight - h - 8, top));
    t.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }
  function hideTip() { if (tip) tip.style.display = 'none'; }

  // ---------------------------------------------------------- escalas
  function niceTicks(max, count = 4) {
    if (!(max > 0)) return [0, 1];
    const raw = max / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || 10 * mag;
    const ticks = [];
    for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
    if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
    return ticks;
  }
  const compact = v => {
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1).replace('.', ',') + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',') + 'M';
    if (a >= 1e4) return Math.round(v / 1e3) + 'K';
    if (a >= 1e3) return (v / 1e3).toFixed(1).replace('.', ',').replace(',0', '') + 'K';
    return String(Math.round(v));
  };

  // re-renderiza quando o contêiner muda de largura
  function mount(container, draw) {
    container.classList.add('viz');
    let lastW = 0;
    const run = () => {
      const w = container.clientWidth;
      if (!w || w === lastW) return;
      lastW = w;
      container.replaceChildren();
      draw(w);
    };
    if (container._ro) container._ro.disconnect();
    container._ro = new ResizeObserver(run);
    container._ro.observe(container);
    run();
    return { redraw() { lastW = 0; run(); } };
  }

  function legend(container, series, shape = 'line') {
    if (series.length < 2) return;
    const lg = document.createElement('div'); lg.className = 'viz-legend';
    for (const s of series) {
      const it = document.createElement('span'); it.className = 'viz-legend-i';
      const k = document.createElement('span'); k.className = 'viz-key ' + shape; k.style.background = s.color;
      const t = document.createElement('span'); t.textContent = s.name;
      it.append(k, t); lg.appendChild(it);
    }
    container.appendChild(lg);
  }

  function axisX(svg, labels, x, y0, fmtX, maxLabels) {
    const n = labels.length;
    const every = Math.max(1, Math.ceil(n / maxLabels));
    for (let i = 0; i < n; i += every) {
      const t = el('text', { x: x(i), y: y0 + 18, 'text-anchor': i === 0 ? 'start' : 'middle', class: 'viz-axis' }, svg);
      t.textContent = fmtX(labels[i]);
    }
  }
  function gridY(svg, ticks, y, x0, x1, fmtY) {
    ticks.forEach((t, i) => {
      el('line', { x1: x0, x2: x1, y1: y(t), y2: y(t), class: i === 0 ? 'viz-base' : 'viz-grid' }, svg);
      const tx = el('text', { x: x0 - 10, y: y(t) + 4, 'text-anchor': 'end', class: 'viz-axis' }, svg);
      tx.textContent = fmtY(t);
    });
  }

  // ---------------------------------------------------------- LINHA / ÁREA
  // opts: { labels, series:[{name, values, color}], area, height, fmt, fmtY, fmtX, peak }
  function line(container, opts) {
    const { labels, series, height = 260, fmt = String, fmtY = compact, fmtX = String, area = false } = opts;
    return mount(container, (W) => {
      legend(container, series);
      const max = Math.max(1, ...series.flatMap(s => s.values));
      const ticks = niceTicks(max, 4);
      const yMax = ticks[ticks.length - 1];
      const padL = Math.max(...ticks.map(t => fmtY(t).length)) * 7 + 16, padR = 14, padT = 14, padB = 30;
      const H = height, iw = W - padL - padR, ih = H - padT - padB;
      const n = labels.length;
      const x = i => padL + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
      const y = v => padT + ih - (v / yMax) * ih;
      const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label || 'Gráfico de linhas' });
      container.appendChild(svg);
      gridY(svg, ticks, y, padL, W - padR, fmtY);
      axisX(svg, labels, x, padT + ih, fmtX, Math.max(2, Math.floor(iw / 80)));

      const defs = el('defs', {}, svg);
      series.forEach((s, si) => {
        const pts = s.values.map((v, i) => [x(i), y(v)]);
        const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
        if (area) {
          const gid = 'g' + Math.random().toString(36).slice(2);
          const g = el('linearGradient', { id: gid, x1: 0, x2: 0, y1: 0, y2: 1 }, defs);
          el('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': series.length > 1 ? 0.10 : 0.18 }, g);
          el('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': 0 }, g);
          el('path', { d: d + `L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`, fill: `url(#${gid})` }, svg);
        }
        el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'viz-line' }, svg);
        // ponto final
        const last = pts[pts.length - 1];
        if (last) el('circle', { cx: last[0], cy: last[1], r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
      });

      // rótulo seletivo: pico da série única
      if (series.length === 1 && opts.peak !== false && n > 2) {
        const vals = series[0].values; let pi = 0;
        vals.forEach((v, i) => { if (v > vals[pi]) pi = i; });
        if (vals[pi] > 0) {
          const px = x(pi), py = y(vals[pi]);
          el('circle', { cx: px, cy: py, r: 3, fill: 'var(--surface)', stroke: series[0].color, 'stroke-width': 2 }, svg);
          const lbl = el('text', { x: Math.min(Math.max(px, padL + 40), W - padR - 40), y: Math.max(py - 10, 12), 'text-anchor': 'middle', class: 'viz-label' }, svg);
          lbl.textContent = 'pico ' + fmt(vals[pi]);
        }
      }

      // crosshair
      const cross = el('line', { y1: padT, y2: padT + ih, class: 'viz-cross', visibility: 'hidden' }, svg);
      const dots = series.map(s => el('circle', { r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }, svg));
      const hit = el('rect', { x: padL, y: padT, width: iw, height: ih, fill: 'transparent', tabindex: 0, class: 'viz-hit' }, svg);
      let focusI = n - 1;
      const at = (i, cx, cy) => {
        i = Math.max(0, Math.min(n - 1, i));
        cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
        series.forEach((s, si) => { dots[si].setAttribute('cx', x(i)); dots[si].setAttribute('cy', y(s.values[i])); dots[si].setAttribute('visibility', 'visible'); });
        const rect = svg.getBoundingClientRect();
        showTip(cx ?? rect.left + x(i), cy ?? rect.top + padT + ih / 2, (opts.fmtTitle || fmtX)(labels[i]),
          series.map(s => ({ color: s.color, value: fmt(s.values[i]), name: s.name })));
      };
      const off = () => { cross.setAttribute('visibility', 'hidden'); dots.forEach(d => d.setAttribute('visibility', 'hidden')); hideTip(); };
      hit.addEventListener('pointermove', e => {
        const r = svg.getBoundingClientRect();
        const i = Math.round(((e.clientX - r.left - padL) / iw) * (n - 1));
        focusI = i; at(i, e.clientX, e.clientY);
      });
      hit.addEventListener('pointerleave', off);
      hit.addEventListener('blur', off);
      hit.addEventListener('focus', () => at(focusI));
      hit.addEventListener('keydown', e => {
        if (e.key === 'ArrowLeft') { focusI = Math.max(0, focusI - 1); at(focusI); e.preventDefault(); }
        if (e.key === 'ArrowRight') { focusI = Math.min(n - 1, focusI + 1); at(focusI); e.preventDefault(); }
      });
    });
  }

  // ---------------------------------------------------------- COLUNAS (simples ou empilhadas)
  // opts: { labels, series:[{name, values, color}], stacked, height, fmt, fmtY, fmtX }
  function columns(container, opts) {
    const { labels, series, height = 260, fmt = String, fmtY = compact, fmtX = String } = opts;
    return mount(container, (W) => {
      legend(container, series, 'rect');
      const n = labels.length;
      const totals = labels.map((_, i) => series.reduce((s, se) => s + (se.values[i] || 0), 0));
      const max = Math.max(1, ...(opts.stacked !== false ? totals : series.flatMap(s => s.values)));
      const ticks = niceTicks(max, 4), yMax = ticks[ticks.length - 1];
      const padL = Math.max(...ticks.map(t => fmtY(t).length)) * 7 + 16, padR = 8, padT = 14, padB = 30;
      const H = height, iw = W - padL - padR, ih = H - padT - padB;
      const band = iw / n;
      const bw = Math.min(24, Math.max(2, band - 2));
      const x = i => padL + band * i + band / 2;
      const y = v => padT + ih - (v / yMax) * ih;
      const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label || 'Gráfico de colunas' });
      container.appendChild(svg);
      gridY(svg, ticks, y, padL, W - padR, fmtY);
      axisX(svg, labels, x, padT + ih, fmtX, Math.max(2, Math.floor(iw / 80)));
      const r = Math.min(4, bw / 2);

      for (let i = 0; i < n; i++) {
        const g = el('g', { class: 'viz-col' }, svg);
        let acc = 0;
        const segs = series.map(s => ({ s, v: s.values[i] || 0 })).filter(o => o.v > 0);
        segs.forEach((o, k) => {
          const y0 = y(acc), y1 = y(acc + o.v);
          const top = k === segs.length - 1;
          const gap = k > 0 ? 2 : 0; // separador de 2px na cor da superfície
          const h = Math.max(0, y0 - y1 - gap);
          const xl = x(i) - bw / 2;
          if (h <= 0) { acc += o.v; return; }
          const yt = y0 - gap - h;
          const rr = top ? Math.min(r, h) : 0;
          const d = `M${xl},${y0 - gap}V${yt + rr}Q${xl},${yt} ${xl + rr},${yt}H${xl + bw - rr}Q${xl + bw},${yt} ${xl + bw},${yt + rr}V${y0 - gap}Z`;
          el('path', { d, fill: o.s.color }, g);
          acc += o.v;
        });
        const hit = el('rect', { x: padL + band * i, y: padT, width: band, height: ih, fill: 'transparent', class: 'viz-hit' }, g);
        hit.addEventListener('pointermove', e => {
          g.classList.add('on');
          const rows = series.map(s => ({ color: s.color, value: fmt(s.values[i] || 0), name: s.name, shape: 'rect' }));
          if (series.length > 1) rows.push({ color: 'transparent', value: fmt(totals[i]), name: 'Total' });
          showTip(e.clientX, e.clientY, (opts.fmtTitle || fmtX)(labels[i]), rows);
        });
        hit.addEventListener('pointerleave', () => { g.classList.remove('on'); hideTip(); });
      }
    });
  }

  // ---------------------------------------------------------- ROSCA
  // opts: { segments:[{label, value, color}], fmt, center, size }
  function donut(container, opts) {
    const { segments, fmt = String, size = 168 } = opts;
    return mount(container, () => {
      const total = segments.reduce((s, x) => s + x.value, 0) || 1;
      const wrap = document.createElement('div'); wrap.className = 'viz-donut';
      container.appendChild(wrap);
      const S = size, R = S / 2 - 4, rIn = R - 16;
      const svg = el('svg', { width: S, height: S, viewBox: `0 0 ${S} ${S}`, role: 'img', 'aria-label': opts.label || 'Gráfico de rosca' });
      wrap.appendChild(svg);
      const c = S / 2;
      const arc = (a0, a1, r1, r0) => {
        const p = (a, r) => [c + r * Math.sin(a), c - r * Math.cos(a)];
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const [x0, y0] = p(a0, r1), [x1, y1] = p(a1, r1), [x2, y2] = p(a1, r0), [x3, y3] = p(a0, r0);
        return `M${x0},${y0}A${r1},${r1} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 ${large} 0 ${x3},${y3}Z`;
      };
      const centerV = el('text', { x: c, y: c + 2, 'text-anchor': 'middle', class: 'viz-donut-v' }, svg);
      const centerL = el('text', { x: c, y: c + 20, 'text-anchor': 'middle', class: 'viz-axis' }, svg);
      const reset = () => { centerV.textContent = opts.centerValue ?? fmt(total); centerL.textContent = opts.centerLabel ?? 'total'; };
      reset();
      let a = 0;
      const paths = segments.map(sg => {
        const span = (sg.value / total) * Math.PI * 2;
        const pth = el('path', { d: arc(a, a + Math.max(span, 0.0001), R, rIn), fill: sg.color, stroke: 'var(--surface)', 'stroke-width': 2, class: 'viz-seg', tabindex: 0 }, svg);
        a += span;
        const on = (e) => {
          paths.forEach(p => p.classList.toggle('dim', p !== pth));
          centerV.textContent = Math.round((sg.value / total) * 100) + '%';
          centerL.textContent = sg.label;
          if (e && e.clientX) showTip(e.clientX, e.clientY, sg.label, [{ color: sg.color, value: fmt(sg.value), name: Math.round((sg.value / total) * 1000) / 10 + '% do total', shape: 'rect' }]);
        };
        const off = () => { paths.forEach(p => p.classList.remove('dim')); reset(); hideTip(); };
        pth.addEventListener('pointermove', on); pth.addEventListener('pointerleave', off);
        pth.addEventListener('focus', () => on()); pth.addEventListener('blur', off);
        return pth;
      });
      // legenda com valores
      const list = document.createElement('ul'); list.className = 'viz-donut-list';
      segments.forEach((sg, i) => {
        const li = document.createElement('li');
        const k = document.createElement('span'); k.className = 'viz-key rect'; k.style.background = sg.color;
        const n = document.createElement('span'); n.className = 'n'; n.textContent = sg.label;
        const p = document.createElement('span'); p.className = 'p'; p.textContent = Math.round((sg.value / total) * 100) + '%';
        const v = document.createElement('b'); v.textContent = fmt(sg.value);
        li.append(k, n, p, v);
        li.addEventListener('pointerenter', () => paths[i].dispatchEvent(new Event('focus')));
        li.addEventListener('pointerleave', () => paths[i].dispatchEvent(new Event('blur')));
        list.appendChild(li);
      });
      wrap.appendChild(list);
    });
  }

  // ---------------------------------------------------------- BARRAS HORIZONTAIS (ranking)
  // opts: { rows:[{label, sub, value, color}], fmt, max }
  function bars(container, opts) {
    const { rows, fmt = String } = opts;
    container.classList.add('viz');
    container.replaceChildren();
    const max = opts.max || Math.max(1, ...rows.map(r => r.value));
    const ul = document.createElement('ul'); ul.className = 'viz-bars';
    rows.forEach((r) => {
      const li = document.createElement('li');
      const top = document.createElement('div'); top.className = 'viz-bars-top';
      const lab = document.createElement('span'); lab.className = 'l'; lab.textContent = r.label;
      if (r.sub) { const s = document.createElement('small'); s.textContent = r.sub; lab.appendChild(s); }
      const val = document.createElement('b'); val.textContent = fmt(r.value);
      top.append(lab, val);
      const track = document.createElement('div'); track.className = 'viz-bars-track';
      const fill = document.createElement('div'); fill.className = 'viz-bars-fill';
      fill.style.width = Math.max(0.5, (r.value / max) * 100) + '%';
      fill.style.background = r.color || 'var(--series-1)';
      track.appendChild(fill);
      li.append(top, track);
      if (r.extra) li.addEventListener('pointermove', e => showTip(e.clientX, e.clientY, r.label, r.extra));
      li.addEventListener('pointerleave', hideTip);
      ul.appendChild(li);
    });
    container.appendChild(ul);
  }

  // ---------------------------------------------------------- MAPA DE CALOR (dia da semana × hora)
  // opts: { rows:[label], cols:[label], values:[[...]], fmt, ramp:[hex...] }
  function heatmap(container, opts) {
    const { rows, cols, values, fmt = String } = opts;
    const ramp = opts.ramp || ['#16233a', '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#86b6ef', '#b7d3f6'];
    return mount(container, (W) => {
      const padL = 36, padT = 4, padB = 22;
      const cw = (W - padL) / cols.length;
      const ch = Math.min(opts.cellMax || 30, Math.max(14, cw * 0.9));
      const H = padT + ch * rows.length + padB;
      const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label || 'Mapa de calor' });
      container.appendChild(svg);
      const max = Math.max(1, ...values.flat());
      rows.forEach((rl, ri) => {
        const t = el('text', { x: 0, y: padT + ri * ch + ch / 2 + 4, class: 'viz-axis' }, svg); t.textContent = rl;
        cols.forEach((cl, ci) => {
          const v = values[ri][ci] || 0;
          const idx = v === 0 ? 0 : Math.min(ramp.length - 1, 1 + Math.floor((v / max) * (ramp.length - 1.001)));
          const cell = el('rect', { x: padL + ci * cw + 1, y: padT + ri * ch + 1, width: Math.max(1, cw - 2), height: ch - 2, rx: 2, fill: ramp[idx], class: 'viz-cell' }, svg);
          cell.addEventListener('pointermove', e => showTip(e.clientX, e.clientY, `${rl} · ${cl}`, [{ color: ramp[idx], value: fmt(v), name: opts.unit || '', shape: 'rect' }]));
          cell.addEventListener('pointerleave', hideTip);
        });
      });
      cols.forEach((cl, ci) => {
        if (ci % (cw < 22 ? 3 : 2)) return;
        const t = el('text', { x: padL + ci * cw + cw / 2, y: H - 6, 'text-anchor': 'middle', class: 'viz-axis' }, svg); t.textContent = cl;
      });
    });
  }

  // ---------------------------------------------------------- FUNIL
  // opts: { stages:[{label, value}], fmt }
  function funnel(container, opts) {
    const { stages, fmt = String } = opts;
    const ramp = ['#86b6ef', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab'];
    container.classList.add('viz');
    container.replaceChildren();
    const max = Math.max(1, stages[0]?.value || 1);
    const wrap = document.createElement('div'); wrap.className = 'viz-funnel';
    stages.forEach((s, i) => {
      const row = document.createElement('div'); row.className = 'viz-funnel-r';
      const lab = document.createElement('div'); lab.className = 'l';
      const nm = document.createElement('span'); nm.textContent = s.label;
      const val = document.createElement('b'); val.textContent = fmt(s.value);
      lab.append(nm, val);
      const track = document.createElement('div'); track.className = 'viz-funnel-track';
      const bar = document.createElement('div'); bar.className = 'viz-funnel-bar';
      bar.style.width = Math.max(1, (s.value / max) * 100) + '%';
      bar.style.background = ramp[Math.min(i, ramp.length - 1)];
      track.appendChild(bar);
      const conv = document.createElement('div'); conv.className = 'viz-funnel-c';
      conv.textContent = i === 0 ? '100%' : (stages[i - 1].value ? ((s.value / stages[i - 1].value) * 100).toFixed(1).replace('.', ',') + '%' : '—');
      conv.title = 'Conversão em relação à etapa anterior';
      row.append(lab, track, conv);
      wrap.appendChild(row);
    });
    container.appendChild(wrap);
  }

  // ---------------------------------------------------------- SPARKLINE (string SVG)
  function spark(values, { color = 'var(--series-1)', w = 120, h = 32 } = {}) {
    if (!values.length) return '';
    const max = Math.max(...values), min = Math.min(...values);
    const span = max - min || 1;
    const pts = values.map((v, i) => [(i / (values.length - 1 || 1)) * (w - 4) + 2, h - 3 - ((v - min) / span) * (h - 6)]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
    const last = pts[pts.length - 1];
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <path d="${d}" fill="none" stroke="var(--spark)" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="${pts.slice(-Math.max(2, Math.ceil(values.length / 4))).map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${last[0]}" cy="${last[1]}" r="2.5" fill="${color}"/></svg>`;
  }

  window.NXChart = { line, columns, donut, bars, heatmap, funnel, spark, compact, hideTip };
})();
