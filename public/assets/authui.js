// NEXUS — formulário de entrar/criar conta compartilhado (site e painel).
// window.NXLogin(container, { onDone(result), title, subtitle })
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const whenAuth = () => window.NXAuth ? Promise.resolve(window.NXAuth) : new Promise(r => window.addEventListener('nx-auth-ready', () => r(window.NXAuth), { once: true }));
  const GOOGLE = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

  window.NXLogin = function (box, opts = {}) {
    let mode = opts.mode || 'login';
    const draw = (msg = '', kind = 'err') => {
      box.innerHTML = `<div class="nxl">
        ${opts.title ? `<div class="nxl-h"><span class="label">${esc(opts.kicker || 'Acesso')}</span><h2>${esc(opts.title)}</h2>${opts.subtitle ? `<p>${esc(opts.subtitle)}</p>` : ''}</div>` : ''}
        <div class="seg nxl-tabs" role="tablist"><button type="button" data-m="login" class="${mode === 'login' ? 'on' : ''}">Entrar</button><button type="button" data-m="register" class="${mode === 'register' ? 'on' : ''}">Criar conta</button></div>
        <button type="button" class="btn lg nxl-google" data-google>${GOOGLE}<span>Continuar com Google</span></button>
        <div class="nxl-or"><span>ou com e-mail</span></div>
        <form novalidate class="nxl-form">
          ${mode === 'register' ? '<label class="field"><span>Nome</span><input class="input" name="name" autocomplete="name" maxlength="60" required></label>' : ''}
          <label class="field"><span>E-mail</span><input class="input" name="email" type="email" autocomplete="email" required></label>
          ${mode !== 'reset' ? `<label class="field"><span>Senha</span><input class="input" name="password" type="password" autocomplete="${mode === 'register' ? 'new-password' : 'current-password'}" required minlength="8">${mode === 'register' ? '<small>Mínimo de 8 caracteres, com letras e números.</small>' : ''}</label>` : ''}
          <div class="nxl-msg ${kind}" role="alert">${esc(msg)}</div>
          <button class="btn primary lg" type="submit">${mode === 'login' ? 'Entrar' : mode === 'register' ? 'Criar conta' : 'Enviar link de redefinição'}</button>
          ${mode === 'login' ? '<a href="#" class="nxl-link" data-reset>Esqueci minha senha</a>' : mode === 'reset' ? '<a href="#" class="nxl-link" data-m="login">Voltar para entrar</a>' : '<small class="muted">Enviaremos um link para confirmar seu e-mail — necessário para comprar.</small>'}
        </form>
      </div>`;
      box.querySelectorAll('[data-m]').forEach(b => b.onclick = e => { e.preventDefault(); mode = b.dataset.m; draw(); });
      const rs = box.querySelector('[data-reset]'); if (rs) rs.onclick = e => { e.preventDefault(); mode = 'reset'; draw(); };
      const form = box.querySelector('form');
      const busy = on => box.querySelectorAll('button').forEach(b => b.disabled = on);
      box.querySelector('[data-google]').onclick = async () => {
        busy(true);
        try { const A = await whenAuth(); opts.onDone(await A.google()); }
        catch (e) { draw((window.NXAuth?.message || String)(e)); }
      };
      form.onsubmit = async e => {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(form));
        if (!d.email) return draw('Informe seu e-mail.');
        if (mode === 'register' && !(String(d.password).length >= 8 && /[a-z]/i.test(d.password) && /\d/.test(d.password))) return draw('Use pelo menos 8 caracteres, com letras e números.');
        busy(true);
        try {
          const A = await whenAuth();
          if (mode === 'reset') { await A.reset(d.email); mode = 'login'; return draw('Se o e-mail tiver conta, enviamos um link para redefinir a senha.', 'ok'); }
          opts.onDone(mode === 'login' ? await A.login(d.email, d.password) : await A.register(d.name, d.email, d.password));
        } catch (err) { draw((window.NXAuth?.message || String)(err)); }
      };
      setTimeout(() => form.querySelector('input')?.focus(), 30);
    };
    draw();
  };
  window.NXWhenAuth = whenAuth;
})();
