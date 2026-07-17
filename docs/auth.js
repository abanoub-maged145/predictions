// ============================================================
// شاشة القفل — بتقارن بصمة SHA-256 لكلمة السر ببصمة config.js
// أول ما تدخل صح، الجهاز بيفتكرك لحد ما كلمة السر تتغير
// ============================================================
(() => {
  const KEY = 'predictor_auth_v1';

  // الجهاز فاكر كلمة السر الصحيحة الحالية؟ ادخل على طول
  if (localStorage.getItem(KEY) === window.PASS_HASH) return;

  // اقفل الصفحة لحد ما يدخل كلمة السر
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
      if (hash === window.PASS_HASH) {
        localStorage.setItem(KEY, hash);
        overlay.remove();
        document.documentElement.classList.remove('locked');
      } else {
        const err = document.getElementById('lock-error');
        err.classList.remove('hidden');
        const card = overlay.querySelector('.lock-card');
        card.classList.remove('shake');
        void card.offsetWidth; // إعادة تشغيل الأنيميشن
        card.classList.add('shake');
        document.getElementById('lock-pass').select();
      }
    };
  });
})();
