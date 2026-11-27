<p align="center">
  <img src="frontend/public/logo.png" alt="Madar" width="110" />
</p>

<h1 align="center">Madar (مدار)</h1>

<p align="center">
  بيئة تطوير متكاملة واحترافية لفريق تطوير<br/>
  A self-hosted, all-in-one workspace platform for development teams
</p>

<p align="center">
  <a href="https://github.com/20057AMO/madar/actions/workflows/ci.yml">
    <img src="https://github.com/20057AMO/madar/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <img src="https://img.shields.io/badge/version-BETA-blue" alt="version" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license" />
</p>

---

## نظرة عامة — Overview

**Madar** منصة تطوير ذاتية الاستضافة (self-hosted) تجمع دورة حياة التطوير في مكان واحد — من التخطيط والتصميم إلى التطوير والاختبار والإنتاج.

كل مشروع يحصل على حاوية Docker مستقلة مع محرر VS Code مدمج، وطرفية، ودردشة AI تفهم بنية المشروع بالكامل، لوحة تخطيط بصرية، إدارة فريق، وتخزين آمن — كل ذلك من لوحة تحكم ويب واحدة.

**لا يحتاج دومين أو SSL للاستخدام المحلي فقط**؛ خارج الجهاز تُنشر **نسخة تطبيق واحدة** أمامها nginx مع TLS على `80`/`443`/`4097`، وتُربط `3000`/`4097` على `127.0.0.1` (راجع [docs/INSTALL.md](docs/INSTALL.md#الأمان-في-النشر--security-in-production-deployment)).

> **Madar** is a self-hosted, all-in-one workspace platform for development teams. Every project gets its own isolated Docker container, browser IDE, terminal, AI chat with full codebase context, visual planning canvas, team collaboration, and secure storage — all driven from a single web dashboard. No domain, SSL, or cloud dependency for local use only; outside the host, run a **single app instance** behind nginx/TLS on `80`/`443`/`4097`, with `3000`/`4097` bound to `127.0.0.1` (see [docs/INSTALL.md](docs/INSTALL.md#الأمان-في-النشر--security-in-production-deployment)).

---

## المتطلبات — Requirements

| المتغير | القيمة |
|---------|--------|
| Docker Engine 24+ أو Docker Desktop | مع إضافة `compose` v2. على Windows استخدم WSL2 backend |
| منافذ حرة | محليًا: `3000` (اللوحة + الوكلاء المصادَقون) و`4097` (وكيل VS Code/OpenCode المصادَق). خارج الجهاز: `80`/`443`/`4097` على nginx مع TLS، وتُربط `3000`/`4097` على `127.0.0.1` بواسطة ملف compose للإنتاج. لم تعد `8100`/`4096` منشورة إطلاقًا ([docs/INSTALL.md](docs/INSTALL.md)) |
| مساحة قرص | ~4 GB على الأقل للصور والمشاريع |

أدوات سطر الأوامر: git و curl و awk و grep و cut و tr. systemd اختياري، ويستخدمه سكربت التثبيت لتفعيل التشغيل التلقائي عند الإقلاع فقط؛ على Docker Desktop وmacOS وWSL2 بدون systemd استخدم `bash scripts/install.sh --no-systemd` — [docs/INSTALL.md](docs/INSTALL.md).

> لا يحتاج جهازك Node.js أو أي أدوات تطوير — كل شيء يُبنى داخل Docker.

---

## التثبيت والتشغيل — Installation

### الطريقة الموصى بها — سكربت التثبيت

```bash
git clone https://github.com/20057AMO/madar.git madar && cd madar && bash scripts/install.sh
```

يتحقق السكربت من المتطلبات والمنافذ `3000` و`4097`، وينسخ `.env.example` إلى `.env` مرة واحدة فقط دون لمس `JWT_SECRET`، ثم يبني الحاويات وينتظر فحص الصحة. لا يحتاج جهازك Node.js — كل شيء يُبنى داخل Docker. أعد تشغيل نفس الأمر لاحقًا لتحديث آمن: سحب `--ff-only` ثم إعادة بناء وفحص صحة وتحديث وحدة systemd، ورفض واضح لأي نسخة تحتوي تغييرات محلية.

السكربت يثبّت وحدة الإقلاع فقط عندما يكون systemd هو العملية رقم 1 فعليًا؛ على WSL2 فعّل systemd أو استخدم `--no-systemd`، وسيُشغَّل Madar الآن دون وحدة إقلاع. يُسمح بتثبيت Madar واحد فقط على كل مضيف: الوحدة مرتبطة بمسار تثبيت واحد عبر `WorkingDirectory`، ويرفض السكربت أي وحدة تشير إلى مسار آخر.

بصلاحيات root يثبّت السكربت الوحدة ويفعّلها؛ وإلا يطبع أمر `sudo` جاهزًا لتفعيل التشغيل التلقائي عند الإقلاع. الوحدة تعمل بصلاحيات root وتستخدم `NoNewPrivileges=true`، لذا يجب أن تكون نسخة Madar مملوكة لـ root ومحمية من تعديل المستخدمين العاديين؛ لا تضف إليها ملفات env أو أسرارًا. استخدم `--no-systemd` لتخطي تثبيت الوحدة، و`--dir PATH` و`--branch NAME` لتخصيص مسار التثبيت والفرع. إعادة تشغيل الوحدة تعيد `docker compose up -d` فقط؛ systemd لا يسحب كودًا جديدًا؛ تحديث الكود يتم بإعادة تشغيل سكربت التثبيت، لا بإعادة تشغيل systemd.

لإلغاء التثبيت: `bash scripts/uninstall.sh` (يوقف الحاويات مع الاحتفاظ بالبيانات). إضافة `--remove-data` تنفّذ `docker compose down -v` بعد تأكيد تفاعلي لحذف volumes الإعدادات والجلسات — وهذا **تدميري**. مجلد `workspaces/` ونسخة المشروع لا يُحذفان أبدًا.

> خارج جهازك المحلي: شغّل نسخة تطبيق واحدة خلف nginx/TLS. يوفّر nginx المنافذ `80`/`443`/`4097`، بينما يقَيّد `docker-compose.prod-tls.yml` وصول الحاوية إلى `127.0.0.1:3000` و`127.0.0.1:4097`. لا تكشف `3000`/`4097` مباشرة. فعّل `WSD_TRUSTED_PROXIES` فقط عندما يكون `X-Forwarded-For` مكتوبًا بواسطة وكيل عكسي تتحكم به ([التفاصيل](docs/INSTALL.md#الأمان-في-النشر--security-in-production-deployment)).

### التثبيت اليدوي — Manual

```bash
# 1. انسخ المشروع
git clone https://github.com/20057AMO/madar.git
cd madar

# 2. ابنِ وشغّل
docker compose up -d --build
# انتظر بعض الوقت


# 3. افتح اللوحة
#    http://localhost:3000
```

في أول زيارة ستظهر شاشة **إنشاء الحساب** — اسم مستخدم + كلمة مرور + **رمز الإعداد**. يطبع التطبيق الرمز تلقائيًا في سجل `app` عند أول تشغيل، أو تضبطه بنفسك عبر `WSD_SETUP_TOKEN`. بعد إنشاء الحساب الأول يصبح الإعداد غير متاح (409)، وتُنشأ الحسابات الإضافية من صفحة **الفريق** بواسطة مدير.

### متغيرات البيئة — Environment Variables

| المتغير | مطلوب؟ | الوصف |
|---------|--------|-------|
| `JWT_SECRET` | اختياري | سر توقيع رموز JWT. **ملاحظة**: القيمة الفارغة تُعامل كأن المتغير غير معيّن، فيولّد التطبيق سرًا عشوائيًا ويحفظه في `data/jwt.secret` داخل volume البيانات (0600) — الجلسات غير قابلة للتزوير وتصمد أمام إعادة التشغيل. ضعه فقط للتحكم/التدوير. القيم المعروفة أو القصيرة (أقل من 32 حرفًا) تُرفض ولا تُصلَح |
| `WSD_WORKSPACES_HOST_DIR` | مطلوب على Docker Desktop / اختياري على Linux | يُشتقّ تلقائيًا من `mountinfo` على Linux؛ اضبطه صراحةً على Docker Desktop أو عند مشاركة UNC/WSL |
| `WSD_EMBEDDED_PUBLISH_HOST` | اختياري | واجهة نشر **الوكيل المصادَق** لـVS Code وOpenCode. الافتراضي في compose الأساسي `127.0.0.1`؛ اضبطه صراحةً على `0.0.0.0` فقط للوصول من أجهزة أخرى على شبكة موثوقة، مع TLS أمام `3000`/`4097`. في الإنتاج يعيّن `docker-compose.prod-tls.yml` القيمة `127.0.0.1`. لا تُنشر المنافذ الخام `8100`/`4096` إطلاقًا؛ الخدمتان مربوطتان على `127.0.0.1` داخل الحاوية |
| `WSD_EMBED_PROXY_PORT` | اختياري | منفذ وكيل الأسطح المدمجة المصادَق — الافتراضي `4097` |
| `OLLAMA_API_KEY` | اختياري | مفتاح Ollama Cloud |
| `OPENCODE_API_KEY` | اختياري | مفتاح OpenCode Zen |
| `WSD_CHAT_MODEL` | اختياري | النموذج الافتراضي للدردشة |
| `WSD_SETUP_TOKEN` | اختياري | رمز إنشاء الحساب الأول. إن لم تضبطه، يولّد التطبيق رمزًا عشوائيًا ويطبعه في `docker compose logs app`؛ يُحفظ تجزيؤه SHA-256 في `data/setup.token.sha256` (0600) ويُحذف بعد نجاح الإعداد |
| `WSD_TRUSTED_PROXIES` | اختياري | عناوين IP أو CIDRs أو الأسماء `loopback`/`linklocal`/`uniquelocal` المسموح لها بتعيين `X-Forwarded-For`. استخدمه فقط خلف وكيل عكسي تتحكم به؛ `/0` يُتجاهَل. ويُساوي `WSD_TRUST_PROXY=1` القيم `loopback,uniquelocal` توافقًا مع الإعداد القديم |
| `WSD_TRUST_PROXY` | اختياري | توافق قديم: `1` أو `true` يعادل `WSD_TRUSTED_PROXIES=loopback,uniquelocal`؛ الافتراضي غير مفعّل |
| `WSD_ENC_KEY` | اختياري | مفتاح تشفير مزوّدات الإصدار `v2:` (16–1024 حرفًا). إن لم يضبط، يولّد التطبيق مفتاحًا عشوائيًا في `data/enc.key` (0600). لا مشتق من `JWT_SECRET`. النسخ القديمة `enc1:` تُقرأ فقط بمفتاح `WSD_ENCRYPTION_KEY` أو سر التوقيع القديم، ثم تُعاد كتابتها `v2:` عند تحميل/إعادة كتابة مخزن المزوّدين |

---

## بنية المشروع — Project Structure

```
frontend/             — Preact + TypeScript + Vite (يُخدم في /)
backend/              — Express 5 + Node 22 + WebSocket (ws)
Dockerfile            — Multi-stage: frontend build → backend build → runtime
Dockerfile.workspace  — Ubuntu 26.04 LTS + Node 24 LTS لصورة حاويات المشاريع
docker-compose.yml    — كامل الحزمة
docs/                 — التوثيق
workspaces/           — ملفات المشاريع (تُنشأ عند التشغيل)
opencode/             — وكلاء opencode + مهارات + أوامر مدمجة
```

> صورة `wsd/workspace` تُبنى من `Dockerfile.workspace` على Ubuntu 26.04 LTS وNode 24 LTS، وتحمل وسوم `io.madar.workspace.toolchain.*` وملف `/etc/madar/workspace-toolchain.json` الذي يسجّل الإصدار المُعلَن والفعلي ووقت البناء. فحص البناء يرفض أي صورة لا تطابق Ubuntu 26.04 أو Node 24 LTS أو تحتوي Docker CLI. أعد بناءها يدويًا بـ `docker compose build workspace --no-cache`؛ أمر `docker compose build app` لا يعيد بناءها، ولا يوجد تحديث تلقائي لها. حاويات المشاريع القائمة لا تتغير حتى إعادة إنشائها صراحةً. إصدار Docker الظاهر يُقرأ من daemon المضيف فقط، لا من حاويات المشاريع.

---

## الميزات الرئيسية — Key Features

### 🐳 حاويات مشاريع مستقلة — Isolated Project Containers
كل مشروع يعمل في حاويته الخاصة (`wsd-<slug>`) بمنافذ مستقلة وملفات workspace مربوطة. يُشغّل `sleep infinity` — أنت تتحكم بتشغيل الخدمات من الطرفية.

### 🔀 تكامل Git — Git Integration
استنسخ المستودعات من قسم «روابط وصحة» في المشروع، واعرض الملفات المتغيرة والفروقات النصية وحالة الفرع. يمكن للمحررين دفع الـ commits المحلية إلى upstream آمن عبر HTTPS أو SSH؛ لا تُدفع التعديلات غير المسجلة في commit تلقائيًا.

### 💬 دردشة AI ذكية — AI Chat
محادثة بسياق المشروع الكامل: ملفات المشروع والبيانات الوصفية تُحقَّن تلقائيًا في السياق. ردود متدفقة، مرفقات، جلسات محفوظة، وزر إيقاف.

### 🤖 وكلاء AI — AI Agents
28 وكيل متخصص (architect, code-reviewer, security-auditor, debugger, …) + 20 مهارة + 8 أوامر مختصرة. كل وكيل له صلاحيات محددة وtrigger وصفية.

### 📝 لوحة التخطيط البصرية — Visual Planning Canvas
لوحة بيضاء لكل مشروع: ملاحظات لاصقة، بطاقات مهام، علاقات — تُمرَّر كسياق لوكلاء AI.

### 👥 إدارة الفريق — Team & Collaboration
أعضاء بأدوار (admin/editor/viewer)، نقل ملكية، صلاحيات مشروع، دردشة جماعية بقنوات ومحادثات مباشرة.

### 🖥️ محرر VS Code مدمج — Embedded IDE
code-server مدمج في واجهة الويب، وOpenCode Web UI، كلاهما من شريط الجانبي.

### 🔒 أمان متعدد الطبقات — Multi-Layer Security
- مصادقة bcrypt + JWT مع إصدار توقيع لإلغاء الجلسات
- قفل مزوّدات API بكلمة مرور منفصلة
- التحقق بخطوتين (TOTP)
- حماية من القوة الغاشمة (rate limiting)
- سجل أمني (audit log)
- رمز إعداد لإنشاء الحساب الأول: `WSD_SETUP_TOKEN` أو رمز عشوائي يُطبع في سجلات الحاوية؛ لا توجد قفزة loopback تتجاوزه
- تشفير مفاتيح API عند الحفظ (AES-256-GCM، صيغة `v2:` بمفتاح مستقل في `data/enc.key`؛ صيغة `enc1:` القديمة تُقرأ فقط حتى تُعاد كتابتها)
- نسخ احتياطي للإعدادات مع تصدير/استيراد
- نشر `3000`/`4097` على `127.0.0.1` افتراضيًا؛ لا تُنشر المنافذ الخام `8100`/`4096`
- تقليل صلاحية مقبس Docker اختياريًا عبر `docker-compose.socket-proxy.yml` — تخفيف ضرر لا عزل كامل (راجع [SECURITY.md](SECURITY.md))
- `WSD_TRUSTED_PROXIES` لتحديد الوكلاء الموثوقين فقط؛ لا تفعّله إلا خلف وكيل عكسي تتحكم به
- **نسخة تطبيق واحدة فقط**؛ لا replicas ولا HA. عند النشر خارج جهازك ضع nginx/TLS أمام التطبيق على `80`/`443`/`4097`، واربط `3000`/`4097` على `127.0.0.1`. بدون TLS يقرأ أي متناصّ على الشبكة رمز الجلسة وكوكي `madar_embed` معًا. تفاصيل النشر وتهيئة nginx في [docs/INSTALL.md](docs/INSTALL.md#الأمان-في-النشر--security-in-production-deployment)، ونموذج التهديد الكامل في [SECURITY.md](SECURITY.md)، وحدود صلاحيات الوكلاء في [docs/AGENT-SAFETY.md](docs/AGENT-SAFETY.md)

### 📊 مراقبة وتنبيهات — Monitoring & Alerts
تنبيهات تلقائية لتعطل الحاويات (OOM، خروج غير طبيعي)، مؤشرات CPU/RAM، مقاييس التخزين.

### 🗑️ سلة المحذوفات — Trash Bin
حذف المشروع يُؤرشف الملفات أولًا. يمكن استعادتها من تبويب Trash.

### 📸 نسخ احتياطي تلقائي — Scheduled Snapshots
نسخ احتياطي مجدول لكل مشروع (ساعة/3/6/12/24/7 أيام) مع الاحتفاظ بآخر N نسخة.

### 🔄 تحديثات موحّدة — Unified Runtime Updates
تحديث opencode و VS Code (code-server) من داخل اللوحة (Settings → Updates) — للمدير فقط مع تأكيد كلمة المرور، إعادة تشغيل المكوّن المستهدف فقط لبضع ثوانٍ مع إعادة اتصال تلقائية، وrollback تلقائي عند فشل الإقلاع.

---

## أبرز نقاط API — Key API Endpoints

| المسار | الوصف |
|--------|-------|
| `POST /api/auth/login` | تسجيل الدخول (مع 2FA اختياري) |
| `POST /api/auth/logout-all` | إلغاء جميع الجلسات |
| `GET/POST /api/projects` | إدارة المشاريع |
| `POST /api/projects/:slug/start` | تشغيل حاوية |
| `POST /api/projects/:slug/stop` | إيقاف حاوية |
| `GET /api/projects/:slug/logs` | سجلات حية |
| `GET /api/projects/:slug/git` | حالة مستودعات Git والتغييرات |
| `POST /api/projects/:slug/git/push` | دفع commits إلى upstream عبر HTTPS أو SSH |
| `POST /api/projects/:slug/clone` | استنساخ مستودع إلى مساحة العمل |
| `GET /api/projects/:slug/export` | تصدير مشروع كملف `.tar.gz` |
| `POST /api/projects/import` | استيراد مشروع من ملف |
| `GET/PUT /api/projects/:slug/notes` | ملاحظات المشروع |
| `PUT /api/projects/:slug/canvas` | لوحة التخطيط |
| `PUT /api/projects/:slug/ports` | تعديل المنافذ المنشورة |
| `PUT /api/projects/:slug/limits` | حدود الموارد (CPU/RAM) |
| `POST /api/providers` | إدارة مزوّدي LLM |
| `GET /api/storage` | مقاييس التخزين |
| `GET/POST /api/webhooks` | إدارة الـ Webhooks |
| `GET /api/projects/:slug/activity` | سجل نشاط المشروع |
| `WS /ws/projects/:slug/status` | تحديثات الحالة عبر WebSocket |
| `WS /ws/projects/:slug/terminal` | طرفية عبر WebSocket |
| `WS /ws/chat-team` | دردشة الفريق |
| `GET /api/updates` | حالة تحديثات المكوّنات (مدير فقط) |
| `POST /api/updates/check` | فحص فوري للتحديثات |
| `POST /api/updates/apply` | تطبيق تحديث مكوّن — يتطلب كلمة مرور الحساب |

---

## التحديثات الموحّدة — Unified Updates

> التحديث داخل الحاوية (in-place) للمكوّنين الرئيسيين — opencode و VS Code (code-server) — من لوحة Settings → Updates. إداري فقط (admin)، مع تأكيد هوية بكلمة مرور الحساب.

### كيف يعمل — How It Works

- **opencode** (npm): يُجلب أحدث إصدار من سجل npm (`WSD_UPDATE_NPM_REGISTRY`)، يُثبَّت عبر `npm install -g opencode-ai@<latest>` ثم تُعاد تشغيل العملية عبر حلقة الإشراف في `entrypoint.sh` (PID في `$DATA_DIR/opencode-web.pid`). إذا لم يقلع الإصدار الجديد، يُعاد تلقائيًا إلى النسخة السابقة (`rollbackOpencodeTo`).
- **code-server** (deb): يُفحص الإصدار الحالي (`code-server --version`)، ويُجلب أحدث إصدار من GitHub API. الإصدار الذي لا ينشر `digest` SHA-256 كاملًا يُرفض قبل التنزيل؛ عند توفره يُنزَّل ملف `.deb` مع تحقق SHA-256 وسقف حجم، ثم يُثبَّت عبر `dpkg -i`، وتُعاد تشغيل العملية عبر حلقة الإشراف (PID في `$DATA_DIR/code-server.pid`) مع **boot-verify** (إصدار + منفذ + PID). `dpkg-deb --info` يُستخدم فقط كفحص بنيوي احتياطي لنسخ التثبيت/التراجع المثبّتة مسبقًا والتي لا تملك digest إصدار. **Rollback تلقائي**: يُنزَّل ملف `.deb` الحالي مسبقًا (المساحة المطلوبة ≈ 2× حجم الحزمة + هامش 10%) ويُعاد تثبيته إذا فشل الإقلاع.
- زر Studio القديم (`POST /api/opencode-studio/update`) ما زال يعمل ويُشغّل نفس آلية opencode.

### الصلاحيات — Who Can Update

- `GET /api/updates` و `POST /api/updates/check` — **admin فقط** (قراءة/فحص).
- `POST /api/updates/apply` — **admin فقط** + كلمة مرور الحساب عبر `ReAuthModal` (نفس نمط sudo) + حارس القوة الغاشمة للحساب + حد معدل تطبيق 2/دقيقة لكل IP (الفحص الفوري: 6/دقيقة).
- الاستجابة: `202` فور بدء التطبيق في الخلفية (fire-and-forget)، `409` عند وجود تحديث آخر يعمل، `400` لمكوّن/كلمة مرور ناقصة، `401` لكلمة مرور خاطئة.
- `الكل (all)` يشغّل opencode أولًا ثم code-server — فشل opencode يوقف الدفعة قبل إنفاق النطاق على code-server.

### ماذا يحدث أثناء التحديث — During an Update

- يُعاد تشغيل **المكوّن المستهدف فقط** لبضع ثوانٍ (npm لـ opencode أسرع؛ code-server تنزيل ~230 MB + تثبيت + تحقق إقلاع) — الجلسات تعيد الاتصال تلقائيًا.
- شارة إشعار في الشريط الجانبي للمدير (فحص كل 15 دقيقة + عند عودة التبويب للظهور) — خضراء أثناء التطبيق، صفراء عند توفر تحديث.
- **إعادة بناء الصورة** (`docker compose build`) تعيد النسخة المبنية في الصورة (code-server يُحلّ وقت البناء عبر GitHub API مع تحقق SHA-256، وopencode عبر npm ببوابة major 1 — استخدم `--no-cache` لإعادة حلّ latest) — التحديث داخل الحاوية لا يعدّل الصورة.

### متغيرات البيئة — Environment Variables

| المتغير | الافتراضي | الوصف |
|---------|-----------|-------|
| `WSD_UPDATE_GITHUB_BASE` | `https://api.github.com` | قاعدة GitHub API لفحص إصدارات code-server |
| `WSD_UPDATE_DOWNLOAD_BASE` | `https://github.com/coder/code-server/releases` | قاعدة تنزيل ملفات `.deb` |
| `WSD_UPDATE_NPM_REGISTRY` | `https://registry.npmjs.org` | سجل npm لـ opencode (ميرور/بروكسي) |
| `WSD_UPDATES_MAX_BYTES` | `419430400` (400 MB) | سقف حجم ملف `.deb` الواحد |
| `WSD_UPDATE_BOOT_TIMEOUT_MS` | `90000` (90 ثانية) | مهلة تحقق الإقلاع قبل rollback |
| `WSD_RATE_UPDATE_CHECK_MAX` | `6` | حد الفحص الفوري لكل IP/دقيقة |
| `WSD_RATE_UPDATE_APPLY_MAX` | `2` | حد التطبيق لكل IP/دقيقة |

---

## التطوير المحلي — Development

### المتطلبات
- Node.js 22+ (للتطوير المحلي فقط — في الإنتاج يُبنى داخل Docker)

### بناء وتحقق محلي
```bash
# فحص الأنواع — Frontend
(cd frontend && npm run typecheck)

# بناء الإنتاج — Frontend
(cd frontend && npm run build)

# فحص الأنواع — Backend
(cd backend && npm run typecheck)
```

### بناء Docker (للتكامل)
```bash
docker compose build app && docker compose up -d app
```

### الاختبارات
```bash
# تشغيل كامل الاختبارات (الخادم يجب أن يعمل على المنفذ 3000)
cd backend && npm test
```

الاختبارات تعمل بشكل تسلسلي — التشغيل المتزامن قد يُثيّر rate limiter. الحزمة الكاملة تحتاج بيئة `WSD_TESTING=1`؛ حاوية التطوير الافتراضية تستخدم `WSD_TESTING=0` وقد تُنتج `429` في اختبارات إنشاء المشاريع. داخلها شغّل اختبارات `*-core.test.ts` فقط.

### أوامر مفيدة
```bash
docker compose ps              # حالة الحزمة
docker compose logs -f app     # متابعة سجلات اللوحة
docker compose down            # إيقاف مع الاحتفاظ بالبيانات

# ⚠️ تدميري / DESTRUCTIVE: يحذف volume `wsd-data` (الحسابات، الجلسات، مفاتيح المزوّدين).
# ملفات `workspaces/` ونسخة المشروع لا تُحذف لأنها bind mounts.
# استخدم `bash scripts/uninstall.sh --remove-data` للحصول على تأكيد تفاعلي.
docker compose down -v         # إيقاف مع حذف volume البيانات
```

---

## هندسة النظام — Architecture

### المنافذ — Ports

| الخدمة | داخلي داخل حاوية `app` | المنشور على المضيف |
|--------|------------------------|-------------------|
| اللوحة + API | `3000` | `127.0.0.1:3000` افتراضيًا (`$PORT` داخل الحاوية) |
| وكيل VS Code / OpenCode المصادَق | `4097` | `127.0.0.1:4097` افتراضيًا (`$WSD_EMBED_PROXY_PORT`) |
| code-server | `127.0.0.1:8080` | غير منشور؛ يُوصل إليه عبر `4097/ide` فقط |
| OpenCode Web | `127.0.0.1:4096` | غير منشور؛ يُوصل إليه عبر جذر `4097` فقط |
| nginx/TLS للنشر خارج الجهاز | — | `80`/`443` + `4097`، مع ربط `3000`/`4097` على `127.0.0.1` |

`8100` و`4096` لم يعودا منفذَي نشر؛ `8100` محجوز للاستخدام القديم فقط. منافذ حاويات المشاريع (`wsd-<slug>`) تُضاف من إعدادات كل مشروع.

```
┌──────────────────────────────────────────────────────┐
│                   Docker Compose                     │
│                                                      │
│  ┌─────────────────────────────────────────────────┐ │
│  │              app container (port 3000)          │ │
│  │                                                 │ │
│  │  ┌──────────────┐  ┌────────────────────────┐  │ │
│  │  │   Preact     │  │     Express 5 API      │  │ │
│  │  │   Dashboard  │  │     + WebSocket ws     │  │ │
│  │  │   (served /) │  │                        │  │ │
│  │  └──────────────┘  └──────────┬─────────────┘  │ │
│  │                               │                 │ │
│  │  ┌──────────┐  ┌──────────────┴────────────┐   │ │
│  │  │ code-    │  │  Docker Engine (socket)    │   │ │
│  │  │ server   │  │  → wsd-<slug> containers   │   │ │
│  │  │ (127.0.0.1│  │  → wsd/workspace image     │   │ │
│  │  │  :8080)   │  └───────────────────────────┘   │ │
│  │  └──────────┘                                    │ │
│  │        ▲ served only via the authenticated proxy │ │
│  │  ┌─────┴────────────┐  ┌──────────────────────┐   │ │
│  │  │ opencode web    │  │  Project workspaces   │   │ │
│  │  │ (127.0.0.1:4096) │  │  (bind-mount)         │   │ │
│  │  └───────────────┘  └──────────────────────┘   │ │
│  └─────────────────────────────────────────────────┘ │
│                                                      │
│  Volume: wsd-data (accounts, providers, chat)        │
└──────────────────────────────────────────────────────┘
```

للمزيد راجع [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## الترخيص — License

[MIT](LICENSE) © Ahmed M.Ali
فحص الأسرار قبل الالتزام: نفّذ مرة واحدة `node scripts/check-secrets.mjs --install` (تنزيل gitleaks v8.28.0 والتحقق من SHA-256)، ثم يفحص الخطاف الفرق المُرحَّل فقط دون إنترنت.
الحاجز محلي فقط (لا يُطبَّق في CI ويمكن تجاوزه بـ `--no-verify`)؛ لا يُغني عن حماية الأسرار وتأمين الخادم.
