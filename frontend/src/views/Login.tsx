import { useState } from 'preact/hooks';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { PwMeter } from '../components/PwMeter';

export function Login() {
  const { hasUser, login, verify2fa, cancel2fa, pending2fa, setup } = useAuth();
  const { t, t2 } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const isSetup = !hasUser;

  // ── Step 2: authenticator code (2FA accounts) ────────────────
  if (!isSetup && pending2fa) {
    const handleVerify = async (e: Event) => {
      e.preventDefault();
      if (loading) return;
      setError('');
      setLoading(true);
      try {
        await verify2fa(code.trim());
        // success → token stored, Shell reroutes away from /login
      } catch (err: any) {
        setError(err.message || t2('رمز غير صالح', 'Invalid code'));
      } finally {
        setLoading(false);
      }
    };

    return (
      <div class="login-page">
        <div class="login-card">
          <div class="login-brand">
            <img src="/logo.png" alt="Madar" class="login-logo" />
            <h1 class="login-title">{t2('التحقق بخطوتين', 'Two-factor')}</h1>
            <p class="login-sub">{t('login.twoFactorHint')}</p>
          </div>
          <form onSubmit={handleVerify} class="login-form">
            <label class="field-label">{t('login.twoFactor')}</label>
            <input
              class="modern-input login-otp"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              maxLength={7}
              autoFocus
              dir="ltr"
              value={code}
              onInput={(e: any) => setCode(e.target.value)}
            />
            {error && <div class="login-error" role="alert">{error}</div>}
            <button class="btn-primary login-btn" type="submit" disabled={loading}>
              {loading ? t2('جارٍ التحقق…', 'Verifying…') : t('login.verify')}
            </button>
            <button
              class="btn-ghost sm login-back"
              type="button"
              onClick={() => { cancel2fa(); setCode(''); setError(''); }}
            >
              {t('login.backToLogin')}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (loading) return;

    if (!username.trim() || !password) {
      setError(t2('يرجى ملء جميع الحقول.', 'Please fill in all fields.'));
      return;
    }

    if (isSetup && password !== confirm) {
      setError(t('login.passwordMismatch'));
      return;
    }

    if (isSetup && password.length < 6) {
      setError(t2('كلمة المرور يجب أن تكون 6 أحرف على الأقل.', 'Password must be at least 6 characters.'));
      return;
    }

    setError('');
    setLoading(true);

    try {
      if (isSetup) {
        await setup(username.trim(), password);
      } else {
        await login(username.trim(), password);
        // requires2fa → pending2fa flips true and this component renders the code step
      }
    } catch (err: any) {
      setError(err.message || t('errors.generic'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="login-page">
      <div class="login-card">
        <div class="login-brand">
          <img src="/logo.png" alt="Madar" class="login-logo" />
          <h1 class="login-title">Madar</h1>
          <p class="login-sub">
            {isSetup ? t('login.setupHint') : t('login.subtitle')}
          </p>
          <span class="beta-chip login-beta" title="Beta software — features and data format may change">BETA</span>
        </div>

        <form onSubmit={handleSubmit} class="login-form">
          <label class="field-label">{t('login.username')}</label>
          <input
            class="modern-input"
            type="text"
            dir="auto"
            placeholder={t2('أدخل اسم المستخدم', 'Enter username')}
            autoFocus
            value={username}
            onInput={(e: any) => setUsername(e.target.value)}
          />

          <label class="field-label">{t('login.password')}</label>
          <input
            class="modern-input"
            type="password"
            dir="ltr"
            placeholder={isSetup ? t2('6 أحرف على الأقل', 'Min 6 characters') : t2('أدخل كلمة المرور', 'Enter password')}
            value={password}
            onInput={(e: any) => setPassword(e.target.value)}
          />
          {isSetup && password && <PwMeter pw={password} />}

          {isSetup && (
            <>
              <label class="field-label">{t('login.confirmPassword')}</label>
              <input
                class="modern-input"
                type="password"
                dir="ltr"
                placeholder={t('login.confirmPassword')}
                value={confirm}
                onInput={(e: any) => setConfirm(e.target.value)}
              />
            </>
          )}

{error && <div class="login-error" role="alert">{error}</div>}

          <button class="btn-primary login-btn" type="submit" disabled={loading}>
            {loading
              ? isSetup
                ? t('login.creating')
                : t('login.signingIn')
              : isSetup
                ? t('login.createAccount')
                : t('login.signIn')}
          </button>
        </form>
      </div>
    </div>
  );
}
