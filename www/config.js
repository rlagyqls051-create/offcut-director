/* offcut-director 클라우드/홍보 설정 — Supabase 프로젝트 값으로 채우면 로그인·백업 활성화.
 * supabase.com 프로젝트 → Settings → API Keys에서 복사. 미설정이면 로그인 버튼은 숨겨지고
 * 앱은 완전 오프라인으로 동작 (홍보 배너는 항상 표시). */
window.OFFCUT_CONFIG = {
  supabaseUrl: 'https://dczkqzuscntxhnaicdcz.supabase.co',  // OFFCUT_studio 프로젝트
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRjemtxenVzY250eGhuYWljZGN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4MzE3OTQsImV4cCI6MjA5MzQwNzc5NH0.DcrfPc8jRAfqRpO5BNoaqQXuLKKfAdwtFxjNUp3PRIY',
  studioUrl: 'https://offcut.app', // 홍보 배너 클릭 시 이동 — Studio 도메인 확정 시 교체
};
