// Capas procedurais para jogos sem imagem: composição geométrica determinística (a partir do slug).
(function () {
  function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rnd(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function coverSVG(game, { w = 800, h = 350, title = true } = {}) {
    if (game.cover_url) return `<img src="${esc(game.cover_url)}" alt="" loading="lazy">`;
    const r = rnd(hash(game.slug || game.name));
    const a = /^#[0-9a-f]{6}$/i.test(game.accent || '') ? game.accent : '#3987e5';
    const id = 'c' + hash(game.slug + w).toString(36);
    const style = Math.floor(r() * 3);
    let shapes = '';
    if (style === 0) { // anéis concêntricos
      const cx = w * (0.62 + r() * 0.2), cy = h * (0.35 + r() * 0.3);
      for (let i = 0; i < 9; i++) shapes += `<circle cx="${cx}" cy="${cy}" r="${40 + i * 34}" fill="none" stroke="${a}" stroke-opacity="${0.5 - i * 0.05}" stroke-width="${i % 3 ? 1 : 1.6}" ${i % 2 ? 'stroke-dasharray="2 6"' : ''}/>`;
      shapes += `<path d="M${cx - 300},${cy}H${cx + 300}M${cx},${cy - 200}V${cy + 200}" stroke="${a}" stroke-opacity=".35"/>`;
    } else if (style === 1) { // relevo topográfico
      for (let i = 0; i < 14; i++) {
        let d = `M0,${h * 0.25 + i * 18}`;
        for (let x = 0; x <= w; x += 40) d += ` L${x},${h * 0.25 + i * 18 + Math.sin(x / 90 + i * 0.6 + r() * 0.4) * (22 + i * 2)}`;
        shapes += `<path d="${d}" fill="none" stroke="${a}" stroke-opacity="${0.12 + (i / 14) * 0.4}" stroke-width="1.2"/>`;
      }
    } else { // malha em perspectiva
      const hz = h * 0.48;
      for (let i = -12; i <= 12; i++) shapes += `<path d="M${w / 2 + i * 14},${hz} L${w / 2 + i * 120},${h + 40}" stroke="${a}" stroke-opacity=".32"/>`;
      for (let j = 1; j < 9; j++) { const y = hz + (h - hz) * (j / 8) ** 1.8; shapes += `<path d="M0,${y}H${w}" stroke="${a}" stroke-opacity="${0.12 + j * 0.04}"/>`; }
      shapes += `<circle cx="${w / 2}" cy="${hz}" r="${h * 0.32}" fill="${a}" fill-opacity=".16"/><path d="M${w / 2 - h * 0.32},${hz}H${w / 2 + h * 0.32}" stroke="${a}" stroke-opacity=".7"/>`;
    }
    // marcas técnicas
    const ticks = Array.from({ length: 24 }, (_, i) => `<path d="M${24 + i * 10},${h - 20}v${i % 4 ? -4 : -9}" stroke="#fff" stroke-opacity=".35"/>`).join('');
    const name = esc((game.name || '').toUpperCase());
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <radialGradient id="${id}g" cx="70%" cy="30%" r="80%"><stop offset="0" stop-color="${a}" stop-opacity=".38"/><stop offset=".55" stop-color="${a}" stop-opacity=".06"/><stop offset="1" stop-color="#0a0c10" stop-opacity="0"/></radialGradient>
        <linearGradient id="${id}f" x1="0" x2="0" y1="0" y2="1"><stop offset=".45" stop-color="#0a0c10" stop-opacity="0"/><stop offset="1" stop-color="#0a0c10" stop-opacity=".85"/></linearGradient>
        <pattern id="${id}n" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="1" height="1" fill="#fff" fill-opacity=".035"/></pattern>
      </defs>
      <rect width="${w}" height="${h}" fill="#0c0f15"/>
      <rect width="${w}" height="${h}" fill="url(#${id}g)"/>
      ${shapes}
      <rect width="${w}" height="${h}" fill="url(#${id}n)"/>
      <rect width="${w}" height="${h}" fill="url(#${id}f)"/>
      ${ticks}
      <text x="${w - 24}" y="${h - 16}" text-anchor="end" fill="#fff" fill-opacity=".45" font-family="JetBrains Mono, monospace" font-size="11" letter-spacing="2">${esc((game.genre || '').toUpperCase())} · V${esc(game.version || '1.0')}</text>
      ${title ? `<text x="24" y="${h - 44}" fill="#fff" font-family="Inter, sans-serif" font-weight="700" font-size="${Math.min(56, (w - 48) / Math.max(6, name.length) * 1.5)}" letter-spacing="-1">${name}</text>` : ''}
    </svg>`;
  }
  window.coverSVG = coverSVG;
})();
