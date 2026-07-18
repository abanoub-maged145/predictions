// ============================================================
// شاشة القفل — نظام صلاحيتين:
//   كلمة سر الأدمن  → دخول كامل + تبويب الإدارة
//   كلمة سر المستخدمين → دخول عادي
// الجلسة سارية طول ما المتصفح مفتوح. لو كلمة السر اتغيرت
// من الإدارة، الجلسات القديمة بتقع تلقائياً (البصمة مش هتطابق)
// ============================================================
(() => {
  const KEY = 'predictor_auth_v1';

  // باسورد المستخدم صالح لو موجود في القايمة ومدته لسه ماخلصتش
  const validUserHash = h =>
    (window.USER_PASSES || []).some(p => p.hash === h && (!p.expires || Date.parse(p.expires) > Date.now()));

  const saved = sessionStorage.getItem(KEY);
  if (saved === window.ADMIN_HASH) { window.AUTH_ROLE = 'admin'; window.AUTH_HASH = saved; return; }
  if (validUserHash(saved)) { window.AUTH_ROLE = 'user'; window.AUTH_HASH = saved; return; }

  localStorage.removeItem(KEY); // تنضيف جلسات النسخ القديمة
  document.documentElement.classList.add('locked');

  const sha256 = async text => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  };

  document.addEventListener('DOMContentLoaded', () => {
    const overlay = document.createElement('div');
    overlay.id = 'lock-screen';
    overlay.innerHTML = `
      <div class="lock-card">
        <div class="lock-icon">⚽</div>
        <h2>المُتنبئ</h2>
        <p>الموقع محمي — اكتب كلمة السر للدخول</p>
        <form id="lock-form">
          <input type="password" id="lock-pass" placeholder="كلمة السر" autocomplete="current-password" autofocus>
          <button type="submit">دخول 🔓</button>
        </form>
        <p id="lock-error" class="lock-error hidden">كلمة السر غلط — جرب تاني</p>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('lock-form').onsubmit = async e => {
      e.preventDefault();
      const val = document.getElementById('lock-pass').value;
      const hash = await sha256(val);
      const role = hash === window.ADMIN_HASH ? 'admin' : validUserHash(hash) ? 'user' : null;
      if (role) {
        sessionStorage.setItem(KEY, hash);
        window.AUTH_ROLE = role;
        window.AUTH_HASH = hash;
        if (role === 'admin') {
          // مفتاح فك تشفير باسوردات المستخدمين — مشتق من كلمة سر الأدمن نفسها
          const keyRaw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('predictor-key:' + val));
          sessionStorage.setItem('predictor_admin_key', btoa(String.fromCharCode(...new Uint8Array(keyRaw))));
        }
        overlay.remove();
        document.documentElement.classList.remove('locked');
        document.dispatchEvent(new CustomEvent('predictor-authed'));
      } else {
        const err = document.getElementById('lock-error');
        err.classList.remove('hidden');
        const card = overlay.querySelector('.lock-card');
        card.classList.remove('shake');
        void card.offsetWidth;
        card.classList.add('shake');
        document.getElementById('lock-pass').select();
      }
    };
  });
})();
