# دليل اختبارات الخلفية — Backend Tests Guide

`cd backend && npm test` يستخدم مشغّلًا معزولًا (`backend/tests/run-npm-test.mjs`)؛ لا يفترض خادمًا يعمل على `3000`. المشغّل يبني السيرفر مرة، يشغّل نسخة واحدة بـ `PORT=0` و`HOST=127.0.0.1`، يقرأ المنفذ الفعلي من `[Madar] TEST_API_PORT=...`، ينتظر `/api/health`، ثم يشغّل السوتات تسلسليًا عبر `node --test --test-concurrency=1`. بعد الانتهاء يوقف الخادم ويمسح مجلداته المؤقتة.

```bash
# Default: all suites; Docker suites skip unless you opt in
cd backend && npm test

# Single suite — pass the path through npm
cd backend && npm test -- tests/project-canvas.test.ts
```

لا تضبط `WSD_TEST_API_URL` أو `WSD_TEST_WS_URL` أو `JWT_SECRET` يدويًا لهذا التشغيل؛ المشغّل يولّدها لكل تشغيل. أي سوتة تستورد `./helpers.ts` يجب أن تمر عبر `npm test`.

---

## فئات السوتات — Suite categories

| الفئة | كيف تتعرّف عليها | الافتراضي |
|---|---|---|
| وحدات نقية | تنتهي بـ `-core.test.ts` أو لا تستورد `./helpers.ts` | تعمل ضمن المشغّل بدون Docker |
| HTTP معزول | تستورد `./helpers.ts` | المشغّل يوفر URL/WS وسر التوقيع وبيانات مؤقتة |
| Docker خفيف | الشرط `process.env.WSD_TEST_DOCKER === '1'` | يُتخطّى افتراضيًا؛ يحتاج Docker وله صلاحية إنشاء حاويات مشاريع |
| Docker ثقيل | الشرط `WSD_TEST_DOCKER_HEAVY === '1'` مع `WSD_TEST_DOCKER === '1'` | يُتخطّى افتراضيًا؛ قد يغيّر حالة `wsd-pro` الحقيقية |
| E2E متصفح | `e2e/*.py` | خارج `npm test`؛ خادم منفصل على `127.0.0.1:3000` |

---

## متغيرات البيئة — Environment variables

| المتغير | الافتراضي | التأثير |
|---|---|---|
| `WSD_TEST_DOCKER` | `0` | ضعه `1` لتشغيل سوتات Docker الخفيفة؛ مطلوب أيضًا للسوتات الثقيلة |
| `WSD_TEST_DOCKER_HEAVY` | `0` | مع `WSD_TEST_DOCKER=1` يشغّل السوتات الثقيلة |
| `WSD_TEST_ACCOUNT_PASSWORD` | `test-password-123` | كلمة مرور حساب الاختبار للسوتات التي تسجّل دخولًا فعليًا؛ بعضها يتخطّى نفسها إن لم تُضبط صراحةً |
| `WSD_TEST_USER` / `WSD_TEST_PASS` | غير مضبوطين | زوج تسجيل دخول حقيقي اختياري لهذه السوتات |
| `WSD_TEST_HARNESS_DEBUG` | غير مضبوط | `1` يطبع ملخص البيئة المحلّولة (بدون قيم الأسرار) |

يدير المشغّل أيضًا `PORT`, `HOST`, `JWT_SECRET`, `WSD_TEST_API_URL`, `WSD_TEST_WS_URL`, `WSD_TESTING`, `WSD_DATA_DIR`, `WSD_PROJECTS_DIR`, `WSD_EMBED_PROXY_PORT` و`OPENCODE_CONFIG_DIR`؛ يستعيد قيمك الأصلية بعد التشغيل.

---

## بوابات Docker — Opt-in gates

```bash
# خفيف: ينشئ حاويات مشاريع فعلية
cd backend && WSD_TEST_DOCKER=1 npm test -- tests/project-notes.test.ts

# ثقيل: قد يعيد إنشاء wsd-pro ويغيّر حالته — استخدمه على بيئة قابلة للاستهلاك فقط
cd backend && WSD_TEST_DOCKER=1 WSD_TEST_DOCKER_HEAVY=1 npm test -- tests/ide-hardening.test.ts
```

السوتات الثقيلة حاليًا: `component-updates`, `embedded-access`, `ide-hardening`, `opencode-delegate`, `project-limits`, `project-ports`, `project-serve`, `projects.lifecycle`. لا تُضمن ضمن التشغيل الافتراضي.

### component-updates.test.ts — Docker-heavy

هذه السوتة تستهدف الحاوية `wsd-pro` نفسها. قبل أي تشغيل تأكد أن Docker Desktop يعمل والحاوية موجودة.

ما تفعله:

1. ترفع خادم Mock على `0.0.0.0:8987..8997` لـ GitHub Releases وnpm registry وتنزيل `.deb`.
2. تعيد إنشاء حاوية `app` عبر `docker compose up -d --no-deps app` مع متغيرات `WSD_UPDATE_*` موجهة للموك.
3. تُنشئ حساب مدير مؤقتًا وتوقّع JWT بسر المشغّل، ثم تختبر الترقية والفشل والاسترجاع والبوابة.
4. تُنسخ احتياطيًا نسخة code-server الأساسية داخل الحاوية (`tar`) لأن `docker cp` لا ينقل symlinks على Windows.
5. في `after()` تستعيد النسخة وإعداد compose السابق وتحذف المدير المؤقت.

هذه السوتة تغيّر حالة حقيقية؛ إذا انقطعت قبل `after()` تحقّق يدويًا من سلامة الحاوية وإعداداتها. بقية السوتات الثقيلة قد تلمس `wsd-pro` أيضًا حسب بوابتها.

---

## ملاحظات Windows (Git Bash)

- شغّل السوتات تسلسليًا دائمًا؛ `npm test` يضبط `--test-concurrency=1` لأن السوتات تتشارك خادمًا واحدًا وميزانيات معدل.
- إذا بدت `before()` في سوتة ثقيلة معلّقة: لها مؤقت ميزانية يُفشلها مع السبب الجذري بدل التعليق إلى الأبد.
- لا تستخدم `docker cp` لنقل أشجار فيها symlinks من الحاوية إلى Windows.
- بعد أي تشغيل متقطع لسوتة ثقيلة، تحقّق من `wsd-pro` يدويًا؛ المشغّل ينظّف خادمه وبياناته المؤقتة فقط.

---

## e2e/ — اختبارات المتصفح (Python)

سكربتات Playwright (`limits_ui.py`, `chat_responsive_ui.py`, `reviews_ui.py`) تعمل ضد خادم منفصل على `127.0.0.1:3000`؛ ليست جزءًا من `npm test`. تسجّل جلسة مدير برمز JWT موقّع بـ `JWT_SECRET` من البيئة أو `.env` الجذر، لذا يجب أن يطابق سر الخادم الهدف.

```bash
cd backend/tests && python e2e/limits_ui.py
```

المطلوب: Python 3 مع `playwright` وChromium (`pip install playwright && playwright install chromium`). يمكن توجيه السكربتات إلى عنوان آخر عبر `WSD_E2E_BASE`.

---

## الاصطلاحات — Conventions

- السوتات التي تنشئ مستخدمين أو مشاريع تنظّفهم في `after()`؛ المشغّل ينظّف خادمه وبياناته المؤقتة في `finally` وعند الإشارات.
- اللاحقة `-core` = وحدات نقية تُختبر منطق الخدمة بدون I/O؛ نسختها `-api`/الكاملة تختبر نفس المنطق عبر HTTP المعزول.
- السوتات تستخدم `uniqueId` كي لا تتصادم أثناء التشغيل التسلسلي داخل بيانات الاختبار المؤقتة.
