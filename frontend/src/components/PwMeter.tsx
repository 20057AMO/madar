import { JSX } from 'preact';
import { useI18n } from '../i18n';

/* Localized per score: the meter sits inside Arabic UI (Settings / Profile /
   Login setup) where hardcoded English labels like "Okay" leaked through. */
const PW_LABELS_AR = ['قصيرة جداً', 'ضعيفة', 'مقبولة', 'جيدة', 'قوية'];
const PW_LABELS_EN = ['Too short', 'Weak', 'Okay', 'Good', 'Strong'];
const PW_COLORS = ['var(--red)', 'var(--red)', 'var(--yellow)', 'var(--green)', 'var(--green)'];

/** Simple password strength heuristic (0-4): length plus character variety. */
function passwordStrength(pw: string): number {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 6) score += 1;
  if (pw.length >= 10) score += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
  else if (/\d/.test(pw) && pw.length >= 8) score += 1;
  if (/[^A-Za-z0-9]/.test(pw)) score += 1;
  return Math.min(score, 4);
}

/** Live strength meter shown under new-password inputs. */
export function PwMeter({ pw }: { pw: string }): JSX.Element {
  const { t2 } = useI18n();
  const score = passwordStrength(pw);
  const ar = PW_LABELS_AR[score];
  const en = PW_LABELS_EN[score];
  return (
    <div class="pw-meter" title={t2(`قوة كلمة المرور: ${ar}`, `Password strength: ${en}`)}>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          class={i < Math.max(score, 1) ? 'pw-seg on' : 'pw-seg'}
          style={i < score ? `background:${PW_COLORS[score]}` : undefined}
        />
      ))}
      <span class="pw-label">{t2(ar, en)}</span>
    </div>
  );
}
