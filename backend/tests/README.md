# دليل اختبارات الخلفية — Backend Tests Guide

كل الاختبارات تعمل بمشغّل Node الأصلي (`node --test`) مع تفريغ أنواع TypeScript — لا حاجة لـ ts-node ولا vitest. النص المختصر في `backend/package.json`:

```bash
# كل السوتات، تسلسليًا (مطلوب — السوتات تتشارك خادمًا واحدًا وميزانيات معدل)
cd backend && npm test          # node --test --test-concurrency=1 "tests/**/*.test.ts"

# سوتة واحدة فقط (الأسرع أثناء التطوير)
cd backend && node --test --test-concurrency=1 tests/project-canvas.test.ts
```

---

## فئات السوتات — Suite categories

| الفئة | كيف تتعرّف عليها | المتطلبات |
|---|---|---|
| **وحدات نقية** (Pure units) | تنتهي بـ `-core.test.ts` أو لا تستورد `./helpers.ts` (مثل `chat-format`, `crypto`, `janitor`, `ws-gate`, `security-scrub`, `opencode-rollback`, `chat-team-bot`) | لا شيء — تعمل في أي مكان، أقل من ثوانٍ |
| **HTTP ضد خادم حي** | تستورد `./helpers.ts` (`auth`, `projects.lifecycle`, `project-notes`, `team-access`, …) | خادم Madar يعمل على `API_URL` + `JWT_SECRET` مطابق |
| **HTTP + حاويات Docker حقيقية** | فئة HTTP السابقة، لكنها تنشئ مشاريع فعلية فتدور حاويات عمل (`project-limits`, `project-ports`, `project-serve`, `project-reviews`, `opencode-delegate`, `opencode-purge`, `chat-team-api`, `archive-api`, `webhooks`, `stress`, …) | Docker يعمل + مساحة قرص كافية |
| **ذاتية القيادة** (Self-driving) | `component-updates.test.ts` فقط | Docker + Compose — انظر القسم الخاص أدناه |
| **E2E بالمتصفح** | `e2e/*.py` (Playwright بـ Python) | خادم يعمل على `127.0.0.1:3000` + `playwright` و Chromium |

القاعدة العامة: أي سوتة تستورد `helpers.ts` تحتاج خادمًا حيًا — اختبار واحد بدون خادم سيُخفق بالاتصال وليس بالمنطق.

---

## متغيرات البيئة — Environment variables

يُحمَّل `.env` من جذر المستودع ثم `backend/.env` (بدون تجاوز). الأهم:

| المتغير | الافتراضي | ملاحظات |
|---|---|---|
| `WSD_TEST_API_URL` | `http://127.0.0.1:3000/api` | **اتركه فارغًا** إلا إذا كان خادمك حقًا على منفذ آخر. تنبيه `component-updates`: الحاوية تُنشر دائمًا على منفذ 3000 عبر compose، لذا توجيه هذا المتغير إلى منفذ معزول (مثل 3100) يجعل `pollHealth` يفحص المنفذ الخطأ ويُخفق التهيئة رغم أن الحاوية سليمة |
| `JWT_SECRET` | — | يجب أن يطابق سر الخادم الحي (من `.env` الجذر). يُستخدم لتوقيع رموز اختبارية بدل كلمات المرور الحقيقية |
| `WSD_TEST_ACCOUNT_PASSWORD` | `test-password-123` | كلمة مرور أول مدير موجود، للسوتات التي تسجّل دخولًا فعليًا |
| `WSD_TESTING` | *(يضبطها الاختبار داخل الحاوية)* | `component-updates` يعيد إنشاء الحاوية بـ `WSD_TESTING=1` لرفع ميزانيات المعدل، ثم يستعيدها إلى `0` في `after()` |

---

## component-updates.test.ts — السوتة ذاتية القيادة

السوتة الوحيدة التي **تُعيد تشكيل بيئتك**: قبل أي تشغيل تأكّد أن الحاوية `wsd-pro` موجودة و Docker Desktop يعمل.

ما تفعله:

1. ترفع خادم Mock على `0.0.0.0:8987..8997` (يحاكي GitHub Releases + npm registry).
2. تعيد إنشاء الحاوية عبر `docker compose up -d` بمتغيرات `WSD_UPDATE_*` موجهة للموك + `WSD_TESTING=1`.
3. تُنشئ حساب مدير مؤقتًا وتوقّع JWT بسر المستودع.
4. تُنسخ احتياطيًا نسخة code-server الأساسية **بالداخل** (`tar` داخل الحاوية) — لأن `docker cp` لا ينقل symlinks على Windows.
5. تبني حزم `code-server` مزيفة بـ `dpkg-deb` داخل الحاوية وتختبر الترقية/الفشل/الاسترجاع/البوابة.
6. في `after()` تُعيد كل شيء: code-server الأساسي، البيئة الافتراضية، حذف المدير المؤقت، وتتحقق من صحة `/api/updates` النهائية.

- **المدة المتوقعة:** 5–10 دقائق (يغلبها النسخ الاحتياطي 429 MB وإعادة إنشاء الحاوية مرتين).
- **بقية السوتات لا تمس `wsd-pro`** — تتعامل مع حاويات المشاريع فقط.
- إذا خفق `before()` فسيُظهر السبب الجذري مباشرة، وإذا خفقت خطوة استعادة في `after()` فستُبلغ `(root cause: …)` بدل خطأ `no fs backup` المضلل القديم.

### متطلبات دقيقة

- Docker Desktop (WSL2 backend على Windows) مع `docker compose` v2.
- منفذ 3000 حرًا ومرتبطًا بالحاوية (إعداد compose الافتراضي) ومنفذ 8100 للـ IDE المدمج.
- ملف `.env` في جذر المستودع يحوي `JWT_SECRET` و `WSD_WORKSPACES_HOST_DIR` — نفس متطلبات تشغيل الخادم.
- الوصول من الحاوية إلى `host.docker.internal` (يوفره `extra_hosts` في compose). فشل شبكي عابر هنا يظهر مرة كل فترة — أعد المحاولة مرة واحدة قبل البحث عن مشكلة حقيقية.

---

## ملاحظات Windows (Git Bash)

- شغّل السوتات **تسلسليًا دائمًا** (`--test-concurrency=1` مضبوط في `npm test`) — عدة سوتات تتشارك خادمًا واحدًا وميزانيات معدل، والتوازي يسبب 429s كاذبة.
- إذا بدت `before()` معلّقة: لها مؤقت ميزانية (10 دقائق) يُفشلها مع السبب الجذري بدل التعليق إلى الأبد — لا حاجة لقتل العملية يدويًا.
- لا تستخدم `docker cp` لنقل أشجار فيها symlinks من الحاوية إلى Windows — هذا سبب اعتماد النسخ الاحتياطي على `tar` داخل الحاوية.
- بعد أي تشغيل متقطع (Ctrl+C خلال `component-updates`)، تأكد يدويًا أن الحاوية سليمة: `docker exec wsd-pro code-server --version` يجب أن يُظهر إصدار الصورة الأساسي، و `WSD_TESTING` داخل الحاوية يجب أن يكون `0`.

---

## e2e/ — اختبارات المتصفح (Python)

ثلاثة سكربتات Playwright (`limits_ui.py`, `chat_responsive_ui.py`, `reviews_ui.py`) ضد خادم يعمل على `127.0.0.1:3000`. تسجّل جلسة مدير برمز JWT موقّع بـ `JWT_SECRET` من المستودع (نفس خدعة `helpers.ts`) فلا تحتاج كلمة مرور حقيقية:

```bash
cd backend/tests && python e2e/limits_ui.py
```

المطلوب: Python 3 مع حزمة `playwright` ومتصفح Chromium مثبتان (`pip install playwright && playwright install chromium`).

---

## الاصطلاحات — Conventions

- كل سوتة تنظّف ما تُنشئه في `after()` (مشاريع، مستخدمون مؤقتون، حالة الحاوية) — لا تعتمد على بقايا تشغيل سابق ولا تتركها.
- اللاحقة `-core` = وحدات نقية تُختبر منطق الخدمة بدون I/O؛ نسختها `-api`/الكاملة تختبر نفس المنطق عبر HTTP الحقيقي.
- الاختبارات تستخدم أسماء فريدة (`uniqueId`) كي تعمل على خادم ببيانات حقيقية دون تصادم.
