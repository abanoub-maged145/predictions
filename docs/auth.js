// ============================================================
// شاشة القفل — نظام صلاحيتين:
//   كلمة سر الأدمن  → دخول كامل + تبويب الإدارة
//   كلمة سر المستخدمين → دخول عادي
// التحقق: PBKDF2 (بطيء عمداً ضد التخمين) مع دعم البصمات القديمة
// (SHA-256) لحد ما تتم ترقيتها من صفحة الإدارة.
// الجلسة سارية طول ما المتصفح مفتوح. لو كلمة السر اتغيرت
// من الإدارة، الجلسات القديمة بتقع تلقائياً (البصمة مش هتطابق)
// ============================================================
(() => {
  const KEY = 'predictor_auth_v1';
  const FAILS_KEY = 'predictor_lock_fails';
  const PBKDF2_ITER = 310000;

  const enc = s => new TextEncoder().encode(s);
  const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  const toB64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const fromB64 = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

  const sha256 = async text => toHex(await crypto.subtle.digest('SHA-256', enc(text)));

  const pbkdf2Bits = async (password, salt, iter) => {
    const keyMat = await crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits']);
    return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, keyMat, 256);
  };
  const pbkdf2Hex = async (password, saltB64, iter) => toHex(await pbkdf2Bits(password, fromB64(saltB64), iter));

  // باسورد المستخدم صالح لو موجود في القايمة ومدته لسه ماخلصتش
  const passActive = p => !p.expires || Date.parse(p.expires) > Date.now();
  const validUserHash = h => !!h && (window.USER_PASSES || []).some(p => p.hash === h && passActive(p));

  const applySession = s => {
    window.AUTH_ROLE = s.r;
    window.AUTH_HASH = s.a;
    window.DATA_NS = s.ns;
    window.DATA_KEY = s.k || null;
  };

  // استرجاع جلسة محفوظة — بندعم شكل الجلسات القديم (نص البصمة على طول)
  const saved = sessionStorage.getItem(KEY);
  if (saved) {
    let s = null;
    try { s = JSON.parse(saved); } catch { s = { a: saved, ns: saved.slice(0, 10), k: null }; }
    if (s && s.a === window.ADMIN_HASH) { applySession({ ...s, r: 'admin' }); return; }
    if (s && validUserHash(s.a)) { applySession({ ...s, r: 'user' }); return; }
  }

  localStorage.removeItem(KEY); // تنضيف جلسات النسخ القديمة
  document.documentElement.classList.add('locked');

  // تهدئة المحاولات: بعد 5 محاولات غلط، استنى مدة بتتضاعف كل مرة
  const getFails = () => { try { return JSON.parse(localStorage.getItem(FAILS_KEY)) || { n: 0, until: 0 }; } catch { return { n: 0, until: 0 }; } };
  const addFail = () => {
    const f = getFails();
    f.n++;
    if (f.n >= 5) f.until = Date.now() + Math.min(2 ** (f.n - 5), 64) * 30 * 1000;
    localStorage.setItem(FAILS_KEY, JSON.stringify(f));
    return f;
  };

  // التحقق: PBKDF2 لو البصمة ليها salt، وإلا SHA-256 القديم
  async function verify(password) {
    const legacyHash = await sha256(password);

    if (window.ADMIN_SALT) {
      const h = await pbkdf2Hex(password, window.ADMIN_SALT, window.ADMIN_ITER || PBKDF2_ITER);
      if (h === window.ADMIN_HASH) return { role: 'admin', authHash: h };
    } else if (legacyHash === window.ADMIN_HASH) {
      return { role: 'admin', authHash: legacyHash };
    }

    for (const p of (window.USER_PASSES || [])) {
      if (!passActive(p)) continue;
      const h = p.salt ? await pbkdf2Hex(password, p.salt, p.iter || PBKDF2_ITER) : legacyHash;
      if (h === p.hash) return { role: 'user', authHash: h };
    }
    return null;
  }

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

    const showError = msg => {
      const err = document.getElementById('lock-error');
      err.textContent = msg;
      err.classList.remove('hidden');
      const card = overlay.querySelector('.lock-card');
      card.classList.remove('shake');
      void card.offsetWidth;
      card.classList.add('shake');
      document.getElementById('lock-pass').select();
    };

    document.getElementById('lock-form').onsubmit = async e => {
      e.preventDefault();
      const f = getFails();
      if (f.until > Date.now()) {
        showError(`محاولات كتير غلط — استنى ${Math.ceil((f.until - Date.now()) / 1000)} ثانية وجرب تاني`);
        return;
      }
      const btn = overlay.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = '⏳';
      const val = document.getElementById('lock-pass').value;
      const result = await verify(val);
      btn.disabled = false; btn.textContent = 'دخول 🔓';

      if (result) {
        localStorage.removeItem(FAILS_KEY);
        // مساحة التخزين ثابتة ببصمة SHA-256 للباسورد — متتغيرش لما نرقّي طريقة التحقق
        const ns = (await sha256(val)).slice(0, 10);
        // مفتاح تشفير بيانات المزامنة — مشتق من الباسورد نفسه فبيطلع نفسه على أي جهاز
        const dataKey = toB64(await pbkdf2Bits(val, enc('predictor-sync-v1'), PBKDF2_ITER));
        const session = { a: result.authHash, ns, k: dataKey, r: result.role };
        sessionStorage.setItem(KEY, JSON.stringify(session));
        applySession(session);
        if (result.role === 'admin') {
          // مفتاح فك تشفير باسوردات المستخدمين — مشتق من كلمة سر الأدمن نفسها
          const keyRaw = await crypto.subtle.digest('SHA-256', enc('predictor-key:' + val));
          sessionStorage.setItem('predictor_admin_key', toB64(keyRaw));
          // بصمة PBKDF2 جاهزة لو الأدمن لسه على النظام القديم وعايز يرقّي من صفحة الإدارة
          if (!window.ADMIN_SALT) {
            const salt = crypto.getRandomValues(new Uint8Array(16));
            sessionStorage.setItem('predictor_admin_upgrade', JSON.stringify({
              hash: toHex(await pbkdf2Bits(val, salt, PBKDF2_ITER)),
              salt: toB64(salt),
              iter: PBKDF2_ITER,
            }));
          }
        }
        overlay.remove();
        document.documentElement.classList.remove('locked');
        document.dispatchEvent(new CustomEvent('predictor-authed'));
      } else {
        const nf = addFail();
        showError(nf.until > Date.now() ? 'محاولات كتير غلط — اتقفل الدخول شوية' : 'كلمة السر غلط — جرب تاني');
      }
    };
  });
})();
