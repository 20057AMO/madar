import { useState } from 'preact/hooks';
import { useAuth } from '../auth';
import { PwMeter } from '../components/PwMeter';

export function Login() {
  const { hasUser, login, verify2fa, cancel2fa, pending2fa, setup } = useAuth();
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
        setError(err.message || 'Invalid code');
      } finally {
        setLoading(false);
      }
    };

    return (
      <div class="login-page">
        <div class="login-card">
          <div class="login-brand">
            <img src="/logo.png" alt="Madar" class="login-logo" />
            <h1 class="login-title">Two-factor</h1>
            <p class="login-sub">Enter the 6-digit code from your authenticator app.</p>
          </div>
          <form onSubmit={handleVerify} class="login-form">
            <label class="field-label">Authenticator code</label>
            <input
              class="modern-input login-otp"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              maxLength={7}
              autoFocus
              value={code}
              onInput={(e: any) => setCode(e.target.value)}
            />
            {error && <div class="login-error" role="alert">{error}</div>}
            <button class="btn-primary login-btn" type="submit" disabled={loading}>
              {loading ? 'Verifying…' : 'Verify'}
            </button>
            <button
              class="btn-ghost sm login-back"
              type="button"
              onClick={() => { cancel2fa(); setCode(''); setError(''); }}
            >
              Back to sign in
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
      setError('Please fill in all fields.');
      return;
    }

    if (isSetup && password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    if (isSetup && password.length < 6) {
      setError('Password must be at least 6 characters.');
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
      setError(err.message || 'Failed');
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
            {isSetup
              ? 'Set up your account to get started'
              : 'Sign in to your account'}
          </p>
          <span class="beta-chip login-beta" title="Beta software — features and data format may change">BETA</span>
        </div>

        <form onSubmit={handleSubmit} class="login-form">
          <label class="field-label">Username</label>
          <input
            class="modern-input"
            type="text"
            placeholder="Enter username"
            autoFocus
            value={username}
            onInput={(e: any) => setUsername(e.target.value)}
          />

          <label class="field-label">Password</label>
          <input
            class="modern-input"
            type="password"
            placeholder={isSetup ? 'Min 6 characters' : 'Enter password'}
            value={password}
            onInput={(e: any) => setPassword(e.target.value)}
          />
          {isSetup && password && <PwMeter pw={password} />}

          {isSetup && (
            <>
              <label class="field-label">Confirm Password</label>
              <input
                class="modern-input"
                type="password"
                placeholder="Confirm password"
                value={confirm}
                onInput={(e: any) => setConfirm(e.target.value)}
              />
            </>
          )}

{error && <div class="login-error" role="alert">{error}</div>}

          <button class="btn-primary login-btn" type="submit" disabled={loading}>
            {loading
              ? isSetup
                ? 'Setting up…'
                : 'Signing in…'
              : isSetup
                ? 'Create Account'
                : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}

