import { useState, useEffect } from 'preact/hooks';
import { Languages } from 'lucide-preact';
import { listStudioAgents, listStudioSkills, type StudioItem } from '../api';

type Lang = 'ar' | 'en';

const LS_KEY = 'wsd.studio.guideLang';

const SLASH_COMMANDS = [
  { cmd: '/review', agent: 'code-reviewer', ar: 'مراجعة كود قبل الدمج أو بعد أي تغيير', en: 'Review code before merge or after any change' },
  { cmd: '/audit-security', agent: 'security-auditor', ar: 'فحص أمني شامل قبل الإصدار أو بعد تغيير auth', en: 'Security sweep before releases or after auth changes' },
  { cmd: '/plan-feature', agent: 'architect', ar: 'تفكيك ميزة كبيرة لخطوات مرتبة قبل البناء', en: 'Break a big feature into ordered tasks before building' },
  { cmd: '/tdd', agent: 'test-writer', ar: 'بناء ميزة اختبار-أول عندما يهم العقد', en: 'Build test-first when the contract matters' },
  { cmd: '/fix-issue', agent: 'debugger', ar: 'خطأ غامض أو إصلاح سابق لم يثبت', en: 'Mysterious bug or a previous fix that did not hold' },
  { cmd: '/refactor-safely', agent: 'refactorer', ar: 'تحسين البنية دون تغيير السلوك', en: 'Improve structure without changing behavior' },
  { cmd: '/explain-code', agent: 'doc-writer', ar: 'فهم كود غير مألوف بسرعة', en: 'Get up to speed on unfamiliar code' },
  { cmd: '/release', agent: 'release-manager', ar: 'إعداد إصدار: semver، changelog، وسم', en: 'Prepare a release: semver, changelog, tag' },
];

interface Section {
  title: Record<Lang, string>;
  points: Record<Lang, string[]>;
}

const SECTIONS: Section[] = [
  {
    title: { ar: 'النموذج الذهني', en: 'The mental model' },
    points: {
      ar: [
        'كل جلسة تبدأ بوكيل أساسي واحد (build) يقرأ رسالتك ويخطط ويعدل الملفات وينفذ الأوامر.',
        'خلفه 28 متخصصًا (Subagents). الوكيل الأساسي يسلمهم مهمة محددة النطاق ثم يدمج تقريرهم في عمله.',
        'المتخصص لا يستبدل الأساسي — بل يعززه. أنت تحاور الأساسي دائمًا.',
      ],
      en: [
        'Every session starts with one primary agent (build) that reads your message, plans, edits files and runs commands.',
        'Behind it stand 28 specialists (subagents). The primary hands them a tightly-scoped job and folds their report back into the work.',
        'Specialists never replace the primary — they reinforce it. You always talk to the primary.',
      ],
    },
  },
  {
    title: { ar: 'التفويض التلقائي مقابل الصريح', en: 'Automatic vs explicit delegation' },
    points: {
      ar: [
        'تلقائيًا: كل وكيل موصوف بعبارات "Use PROACTIVELY when…" فيختار الأساسي المناسب من تلقاء نفسه عند مطابقة السياق — مثال: بعد إنهاء تنفيذ، يستدعي code-reviewer للمراجعة الأمنية.',
        'صريحًا: اذكر اسم الوكيل في رسالتك — "استخدم debugger لإعادة إنتاج هذا الخطأ" — وسيلتزم به الأساسي.',
        'الأسرع على الإطلاق: الأوامر المائلة الجاهزة أدناه.',
      ],
      en: [
        'Automatically: every agent carries "Use PROACTIVELY when…" triggers, so the primary picks the right specialist on context match — e.g. after implementing, it summons code-reviewer for the security pass.',
        'Explicitly: just name the agent — "use debugger to reproduce this failure" — and the primary will comply.',
        'Fastest route of all: the baked slash commands below.',
      ],
    },
  },
  {
    title: { ar: 'مصفوفة الأذونات — لماذا يرفض البعض التعديل؟', en: 'Permissions — why some refuse to edit' },
    points: {
      ar: [
        'المراجعون (code-reviewer, security-auditor, architect…) قراءة فقط بالتصميم: نصائحهم مستقلة لأن من يفحص لا يعدل ما يفحصه بصمت.',
        'المنفذون (backend-developer, frontend-developer, db-expert, refactorer…) يعدلون وينفذون بحرية.',
        'pentester وincident-responder bash فقط — يتحققون ويحتون دون لمس الكود.',
      ],
      en: [
        'Reviewers (code-reviewer, security-auditor, architect…) are read-only by design: their advice stays independent because whoever inspects never silently mutates what they inspect.',
        'Implementers (backend-developer, frontend-developer, db-expert, refactorer…) hold full edit + bash.',
        'pentester and incident-responder get bash only — verify and contain without touching code.',
      ],
    },
  },
  {
    title: { ar: 'وصفات جاهزة', en: 'Proven recipes' },
    points: {
      ar: [
        'ميزة جديدة: /plan-feature ثم نفّذ المهام مع /tdd، ثم /review قبل /release.',
        'خطأ عنيد: صف العرض بدقة ثم /fix-issue — وبعد الإصلاح اطلب اختبار انحدار يثبت الإصلاح.',
        'قبل كل إصدار: /audit-security، وإن وُجدت ثغرة مشكوك فيها فوّض pentester لتأكيدها عمليًا.',
        'مشكلة إنتاج حية: incident-responder يحتوي الوضع أولًا، ثم debugger يبحث عن الجذر بهدوء.',
      ],
      en: [
        'New feature: /plan-feature, execute tasks with /tdd, then /review before /release.',
        'Stubborn bug: describe the symptom precisely, run /fix-issue, then ask for a regression test pinning the fix.',
        'Before every release: /audit-security — if a finding looks exploitable, delegate pentester to prove it live.',
        'Production fire: incident-responder contains first, then debugger hunts the root cause calmly.',
      ],
    },
  },
  {
    title: { ar: 'فن كتابة الرسالة الفعالة', en: 'Writing messages that get great results' },
    points: {
      ar: [
        'هدف واحد لكل رسالة — الرسائل المركبة تُنتج خططًا سطحية.',
        'سمِّ الملفات والمسارات بدقة؛ السياق الضمني أغلى ما يمكن إهداره.',
        'اذكر القيود صراحة: الإطار، نمط الكود، هل نكتب اختبارات، هل نلمس قاعدة البيانات.',
        'الصق الخطأ كاملًا لا مقتطفًا، وعرّف "انتهى" — ما الذي يجب أن يصح لتنتهي المهمة؟',
      ],
      en: [
        'One goal per message — compound asks produce shallow plans.',
        'Name exact files and paths; implied context is the most expensive thing to waste.',
        'State constraints explicitly: framework, house style, whether to write tests, what may be touched.',
        'Paste full errors not snippets, and define done — what must be true for the task to end?',
      ],
    },
  },
];

export function StudioGuide() {
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem(LS_KEY) === 'en' ? 'en' : 'ar'));
  const [agents, setAgents] = useState<StudioItem[]>([]);
  const [skills, setSkills] = useState<StudioItem[]>([]);

  useEffect(() => {
    localStorage.setItem(LS_KEY, lang);
  }, [lang]);

  useEffect(() => {
    listStudioAgents()
      .then((r) => setAgents((r.agents || []).slice().sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {});
    listStudioSkills()
      .then((r) => setSkills((r.skills || []).slice().sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {});
  }, []);

  const rtl = lang === 'ar';
  const t = (ar: string, en: string) => (rtl ? ar : en);

  return (
    <div dir={rtl ? 'rtl' : 'ltr'} style="max-width:860px;margin:0 auto;padding:18px 16px;overflow:auto;height:100%">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <h2 style="margin:0;font-size:1.05rem">{t('دليل الاستخدام — أفضل النتائج من Subagents و Skills', 'User Guide — getting the best from Subagents & Skills')}</h2>
        <span style="flex:1" />
        <button
          class="btn-ghost sm"
          onClick={() => setLang(rtl ? 'en' : 'ar')}
          title={t('Switch to English', 'التحويل إلى العربية')}
        >
          <Languages width={13} height={13} class="icon" /> {rtl ? 'English' : 'العربية'}
        </button>
      </div>

      {SECTIONS.map((s) => (
        <section
          key={s.title.en}
          style="background:rgba(255,255,255,.03);border:1px solid var(--border,#333);border-radius:12px;padding:14px 16px;margin-bottom:12px"
        >
          <h3 style="margin:0 0 8px;font-size:0.88rem;color:var(--accent,#818cf8)">{s.title[lang]}</h3>
          <ul style="margin:0;padding-inline-start:18px;display:flex;flex-direction:column;gap:6px">
            {s.points[lang].map((p, i) => (
              <li key={i} style="font-size:0.78rem;line-height:1.65;color:var(--text-2,#cbd5e1)">
                {p}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section
        style="background:rgba(255,255,255,.03);border:1px solid var(--border,#333);border-radius:12px;padding:14px 16px;margin-bottom:12px"
      >
        <h3 style="margin:0 0 8px;font-size:0.88rem;color:var(--accent,#818cf8)">
          {t('الأوامر المائلة الثمانية', 'The eight slash commands')}
        </h3>
        <table style="width:100%;border-collapse:collapse;font-size:0.75rem">
          <thead>
            <tr style="color:var(--text-3,#94a3b8);text-align:start">
              <th style="padding:4px 8px;text-align:start">{t('الأمر', 'Command')}</th>
              <th style="padding:4px 8px;text-align:start">{t('الوكيل', 'Agent')}</th>
              <th style="padding:4px 8px;text-align:start">{t('متى تستعمله', 'When to use')}</th>
            </tr>
          </thead>
          <tbody>
            {SLASH_COMMANDS.map((c) => (
              <tr key={c.cmd} style="border-top:1px solid var(--border,#333)">
                <td class="mono" style="padding:5px 8px;white-space:nowrap">{c.cmd}</td>
                <td style="padding:5px 8px;white-space:nowrap">@{c.agent}</td>
                <td style="padding:5px 8px;color:var(--text-2,#cbd5e1)">{rtl ? c.ar : c.en}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <RosterTable
        title={t('التشكيلة الحية — الوكلاء', 'Live roster — subagents')}
        items={agents}
        empty={t('جارٍ التحميل…', 'Loading…')}
      />
      <RosterTable
        title={t('التشكيلة الحية — المهارات', 'Live roster — skills')}
        items={skills}
        empty={t('جارٍ التحميل…', 'Loading…')}
      />

      <p style="font-size:0.7rem;color:var(--text-3,#64748b);text-align:center;margin:16px 0 8px">
        {t(
          'هذه الجداول تسحب التشكيلة الفعلية من الخادم لحظة فتح الدليل — تعدّيل الاستوديو يظهر هنا فورًا.',
          'These tables pull the actual roster from the server when the guide opens — Studio edits show up here immediately.',
        )}
      </p>
    </div>
  );
}

function RosterTable({ title, items, empty }: { title: string; items: StudioItem[]; empty: string }) {
  return (
    <section
      style="background:rgba(255,255,255,.03);border:1px solid var(--border,#333);border-radius:12px;padding:14px 16px;margin-bottom:12px"
    >
      <h3 style="margin:0 0 8px;font-size:0.88rem;color:var(--accent,#818cf8)">
        {title} <span style="color:var(--text-3,#94a3b8);font-weight:400">({items.length})</span>
      </h3>
      {items.length === 0 ? (
        <p style="font-size:0.75rem;color:var(--text-3,#94a3b8);margin:0">{empty}</p>
      ) : (
        <table style="width:100%;border-collapse:collapse;font-size:0.74rem">
          <tbody>
            {items.map((it) => (
              <tr key={it.name} style="border-top:1px solid var(--border,#333)">
                <td class="mono" style="padding:5px 8px;white-space:nowrap;vertical-align:top">
                  {it.name}
                </td>
                <td style="padding:5px 8px;color:var(--text-2,#cbd5e1)">{it.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
