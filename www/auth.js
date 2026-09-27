/* auth.js — Supabase Google 로그인 + 로그 클라우드 백업 (선택 기능)
 * 오프라인 퍼스트: SDK는 로그인 버튼을 누를 때 CDN에서 lazy-load,
 * 카메라 Wi-Fi로 인터넷이 없어도 앱 핵심 기능에는 영향 없음.
 *
 * 네이티브 OAuth 흐름: 시스템 브라우저로 Google 동의 → offcut://auth 딥링크 복귀
 * → URL fragment의 토큰으로 세션 설정. 웹은 일반 리다이렉트 흐름.
 */
const Cloud = (() => {
  const cfg = () => (window.OFFCUT_CONFIG || {});
  const configured = () => !!(cfg().supabaseUrl && cfg().supabaseAnonKey);
  let sb = null, user = null, session = null, listeners = [];

  function emit() { listeners.forEach(f => f(user)); }
  const onChange = f => { listeners.push(f); f(user); };

  async function sdk() {
    if (window.supabase) return window.supabase;
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      s.onload = res; s.onerror = () => rej(new Error('네트워크 오류 — 인터넷 연결 상태를 확인하세요'));
      document.head.appendChild(s);
    });
    return window.supabase;
  }

  async function client() {
    if (sb) return sb;
    const { createClient } = await sdk();
    sb = createClient(cfg().supabaseUrl, cfg().supabaseAnonKey);
    sb.auth.onAuthStateChange((_e, s) => { session = s; user = s && s.user; emit(); });
    return sb;
  }

  /* OAuth 복귀 딥링크 처리 — 네이티브 전용 */
  function listenDeepLink() {
    const P = window.Capacitor && window.Capacitor.Plugins;
    if (!P || !P.App || !window.Capacitor.isNativePlatform()) return;
    P.App.addListener('appUrlOpen', async ({ url }) => {
      if (!url || !url.startsWith('offcutdirector://')) return;
      try {
        const hash = url.includes('#') ? url.split('#')[1] : '';
        const p = new URLSearchParams(hash);
        if (p.get('access_token')) {
          const c = await client();
          await c.auth.setSession({ access_token: p.get('access_token'), refresh_token: p.get('refresh_token') || '' });
        }
        if (P.Browser) await P.Browser.close().catch(() => {});
      } catch {}
    });
  }

  async function init() {
    if (!configured()) { emit(); return; }
    listenDeepLink();
    try {
      const c = await client();
      const { data } = await c.auth.getSession();
      session = data.session;
      user = session && session.user;
    } catch {}
    emit();
  }

  async function signIn() {
    const c = await client();
    const native = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
    if (native) {
      const { data, error } = await c.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: 'offcutdirector://auth', skipBrowserRedirect: true },
      });
      if (error) throw error;
      const P = window.Capacitor.Plugins;
      if (P.Browser) await P.Browser.open({ url: data.url });
      else window.open(data.url, '_system');
      return; // 세션은 딥링크 복귀 시 설정됨
    }
    const { error } = await c.auth.signInWithOAuth({ provider: 'google' });
    if (error) throw error;
  }

  async function signOut() { if (sb) await sb.auth.signOut(); user = null; session = null; emit(); }

  // 업로드/서버 인증용 — Supabase JWT (서버는 JWKS 또는 anon secret으로 검증)
  const token = () => session && session.access_token;

  /* 로그 전체를 한 덩어리로 upsert — backups 테이블 (user_id PK, RLS) */
  async function backup(stateJson) {
    if (!sb || !user) throw new Error('로그인이 필요합니다');
    const { error } = await sb.from('backups').upsert({
      user_id: user.id, state: JSON.parse(stateJson), updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  }

  async function restore() {
    if (!sb || !user) throw new Error('로그인이 필요합니다');
    const { data, error } = await sb.from('backups').select('state').eq('user_id', user.id).maybeSingle();
    if (error) throw error;
    return data ? data.state : null;
  }

  return { configured, init, signIn, signOut, backup, restore, onChange, user: () => user, token };
})();
