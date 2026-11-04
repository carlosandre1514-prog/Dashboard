// NEXUS — autenticação com Firebase (SDK oficial empacotado localmente).
// O Firebase confirma a identidade; o servidor confere o token e decide o papel (admin ou jogador).
import {
  initializeApp, getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  GoogleAuthProvider, signInWithPopup, sendEmailVerification, sendPasswordResetEmail, updateProfile,
  reauthenticateWithCredential, reauthenticateWithPopup, EmailAuthProvider, browserLocalPersistence, setPersistence, reload,
} from '/assets/vendor/firebase.js';

const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'nexus' }, body: JSON.stringify(body || {}) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'Erro ' + r.status); e.status = r.status; throw e; }
  return d;
};
const visitor = (() => { try { return localStorage.getItem('nx_v') || ''; } catch { return ''; } })();

const MSG = {
  'auth/invalid-credential': 'E-mail ou senha incorretos.',
  'auth/wrong-password': 'E-mail ou senha incorretos.',
  'auth/user-not-found': 'E-mail ou senha incorretos.',
  'auth/invalid-email': 'E-mail inválido.',
  'auth/email-already-in-use': 'Este e-mail já tem conta. Use "Entrar".',
  'auth/weak-password': 'Senha fraca: use pelo menos 8 caracteres, com letras e números.',
  'auth/too-many-requests': 'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
  'auth/popup-closed-by-user': 'A janela de login foi fechada antes de concluir.',
  'auth/popup-blocked': 'O navegador bloqueou a janela de login. Permita pop-ups para este site.',
  'auth/network-request-failed': 'Sem conexão com o servidor de login. Verifique sua internet.',
  'auth/operation-not-allowed': 'Este método de login não está ativado no Firebase (Authentication → Sign-in method).',
  'auth/unauthorized-domain': 'Este domínio não está autorizado no Firebase (Authentication → Settings → Authorized domains).',
  'auth/requires-recent-login': 'Por segurança, entre novamente.',
  'auth/user-disabled': 'Esta conta foi desativada.',
  'auth/missing-password': 'Digite sua senha.',
  'auth/user-mismatch': 'Use a mesma conta com que você entrou.',
  'auth/unauthorized-continue-uri': 'Domínio do site não autorizado no Firebase (Authentication → Settings → Authorized domains).',
  'auth/invalid-continue-uri': 'Endereço de retorno inválido para o e-mail de confirmação.',
  'nx/no-user': 'Sua sessão de login expirou neste navegador. Entre de novo com e-mail e senha para reenviar.',
};
const message = e => MSG[e?.code] || e?.message || 'Não foi possível concluir. Tente novamente.';

let auth = null, initError = null;
try {
  const { firebase } = await fetch('/api/public/config').then(r => r.json());
  auth = getAuth(initializeApp(firebase));
  auth.languageCode = 'pt';
  await setPersistence(auth, browserLocalPersistence);
} catch (e) { initError = e; }

const ready = new Promise(res => { if (!auth) return res(null); const off = onAuthStateChanged(auth, u => { off(); res(u); }); });
const need = () => { if (!auth) throw new Error('Serviço de login indisponível: ' + (initError?.message || '')); };
const session = async (user, name) => post('/api/auth/session', { id_token: await user.getIdToken(true), name, visitor });
// o link do e-mail volta para o site, que confirma sozinho
const verifyLink = () => ({ url: location.origin + '/conta?verificado=1', handleCodeInApp: false });
async function sendVerify(user) { await sendEmailVerification(user, verifyLink()); }

window.NXAuth = {
  message,
  ready,
  user: () => auth?.currentUser || null,
  provider: () => auth?.currentUser?.providerData?.[0]?.providerId || null,
  async login(email, password) { need(); const c = await signInWithEmailAndPassword(auth, email.trim(), password); return session(c.user); },
  async register(name, email, password) {
    need();
    const c = await createUserWithEmailAndPassword(auth, email.trim(), password);
    if (name) await updateProfile(c.user, { displayName: name });
    let verify_error = null;
    try { await sendVerify(c.user); } catch (e) { verify_error = message(e); }
    const r = await session(c.user, name);
    return { ...r, verify_sent: !verify_error, verify_error };
  },
  async google() { need(); const c = await signInWithPopup(auth, new GoogleAuthProvider()); return session(c.user); },
  async reset(email) { need(); await sendPasswordResetEmail(auth, email.trim()); },
  async resendVerification() {
    need(); await ready;
    if (!auth.currentUser) throw Object.assign(new Error('sem login'), { code: 'nx/no-user' });
    await sendVerify(auth.currentUser);
    return auth.currentUser.email;
  },
  // depois que o usuário clica no link do e-mail: recarrega e renova o token para o servidor ver "verificado"
  async refreshVerification() { need(); await ready; if (!auth.currentUser) return null; await reload(auth.currentUser); return session(auth.currentUser); },
  // reconecta ao servidor usando o login do Firebase guardado no navegador (sem digitar senha)
  async resume() { need(); await ready; if (!auth.currentUser) return null; return session(auth.currentUser); },
  async mfa(mfa_token, code, remember = true) { return post('/api/admin/login/mfa', { mfa_token, code, remember: !!remember }); },
  // confirmação de identidade para ações sensíveis: devolve um token recém-emitido
  async freshToken({ email, password, useGoogle } = {}) {
    need();
    const u = auth.currentUser;
    if (useGoogle) {
      if (u) await reauthenticateWithPopup(u, new GoogleAuthProvider()); else await signInWithPopup(auth, new GoogleAuthProvider());
    } else {
      if (u && u.email === email) await reauthenticateWithCredential(u, EmailAuthProvider.credential(email, password));
      else await signInWithEmailAndPassword(auth, email, password);
    }
    return auth.currentUser.getIdToken(true);
  },
  async logout() {
    try { await post('/api/auth/logout'); } catch { }
    if (auth) await signOut(auth).catch(() => { });
  },
};
window.dispatchEvent(new Event('nx-auth-ready'));
