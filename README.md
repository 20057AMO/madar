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

**Madar** هو منصة تطوير ذاتية الاستضافة (self-hosted) توحيد كامل دورة حياة التطوير في مكان واحد — من التخطيط والتصميم إلى التطوير والاختبار والإنتاج.

كل مشروع يحصل على حاوية Docker مستقلة مع محرر VS Code مدمج، وطرفية، ودردشة AI تفهم بنية المشروع بالكامل، لوحة تخطيط بصرية، إدارة فريق، وتخزين آمن — كل ذلك من لوحة تحكم ويب واحدة.

**لا يحتاج Domain ولا SSL ولا خدمات سحابية** — يُشغّل محليًا أو على خادم خاص.

> **Madar** is a self-hosted, all-in-one workspace platform for development teams. Every project gets its own isolated Docker container, browser IDE, terminal, AI chat with full codebase context, visual planning canvas, team collaboration, and secure storage — all driven from a single web dashboard. No domain, SSL, or cloud dependency required.

---

## المتطلبات — Requirements

| المتغير | القيمة |
|---------|--------|
| Docker Engine 24+ أو Docker Desktop | مع إضافة `compose` v2. على Windows استخدم WSL2 backend |
| منافذ حرة | `3000` (اللوحة)، `8100` (المحرر)، `4096` (OpenCode) |
| مساحة قرص | ~4 GB على الأقل للصور والمشاريع |

> لا يحتاج جهازك Node.js أو أي أدوات تطوير — كل شيء يُبنى داخل Docker.

---

## التثبيت والتشغيل — Installation

```bash
# 1. انسخ المشروع
git clone https://github.com/20057AMO/madar.git
cd madar

# 2. أنشئ ملف البيئة
cp .env.example .env

# 3. عدّل .env — المطلوب:
#    JWT_SECRET: ولّده بأمر:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#    WSD_WORKSPACES_HOST_DIR: المسار المطلق لمجلد workspaces/
#      ويندوز: D:/madar/workspaces
#      لينكس:  /home/me/madar/workspaces

# 4. ابنِ وشغّل
docker compose up -d --build

# 5. افتح اللوحة
#    http://localhost:3000
```

في أول زيارة ستظهر شاشة **إنشاء الحساب** — اسم مستخدم + كلمة مرور. هذا الحساب الوحيد.

### متغيرات البيئة — Environment Variables

| المتغير | مطلوب؟ | الوصف |
|---------|--------|-------|
| `JWT_SECRET` | نعم | سر توقيع رموز JWT |
| `WSD_WORKSPACES_HOST_DIR` | نعم* | المسار المطلق لمجلد `workspaces/` على المضيف |
| `OLLAMA_API_KEY` | اختياري | مفتاح Ollama Cloud |
| `OPENCODE_API_KEY` | اختياري | مفتاح OpenCode Zen |
| `WSD_CHAT_MODEL` | اختياري | النموذج الافتراضي للدردشة |
| `WSD_IDE_PASSWORD` | اختياري | كلمة مرور المحرر الثابتة |

> مطلوب على Docker Desktop، اختياري على نواة Linux الأصلية.

---

## بنية المشروع — Project Structure

```
frontend/             — Preact + TypeScript + Vite (يُخدم في /)
backend/              — Express 5 + Node 22 + WebSocket (ws)
Dockerfile            — Multi-stage: frontend build → backend build → runtime
Dockerfile.workspace  — Ubuntu 24.04 لصورة حاويات المشاريع
docker-compose.yml    — كامل الحزمة
docs/                 — التوثيق
workspaces/           — ملفات المشاريع (تُنشأ عند التشغيل)
opencode/             — وكلاء opencode + مهارات + أوامر مدمجة
```

---

## الميزات الرئيسية — Key Features

### 🐳 حاويات مشروعة مستقلة — Isolated Project Containers
كل مشروع يعمل في حاويته الخاصة (`wsd-<slug>`) بمنافذ مستقلة وملفات workspace مربوطة. يُشغّل `sleep infinity` — أنت تتحكم بتشغيل الخدمات من الطرفية.

### 💬 دردشة AI ذكية — AI Chat
محادثة بسياق المشروع الكامل: ملفات المشروع والبيانات الوصفية تُحقَّن تلقائيًا في السياق. ردود متدفقة، مرفقات، جلسات محفوظة، وزر إيقاف.

### 🤖 وكلاء AI — AI Agents
27 وكيل متخصص (architect, code-reviewer, security-auditor, debugger, …) + 10 مهارات + 8 أوامر مختصرة. كل وكيل له صلاحيات محددة وtrigger وصفية.

### 📝 لوحة التخطيط البصرية — Visual Planning Canvas
لوحة بيضاء لكل مشروع: ملاحظات لاصقة، بطاقات مهام، علاقات — تُمرر كسياق لوكلا AI.

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
- تشفير مفاتيح API عند الحفظ (AES-256-GCM)
- نسخ احتياطي للإعدادات مع تصدير/استيراد

### 📊 مراقبة وتنبيهات — Monitoring & Alerts
تنبيهات تلقائية لتعطل الحاويات (OOM، خروج غير طبيعي)، مؤشرات CPU/RAM، مقاييس التخزين.

### 🗑️ سلة المحذوفات — Trash Bin
حذف المشروع يُؤرشف الملفات أولًا. يمكن استعادتها من تبويب Trash.

### 📸 نسخ احتياطي تلقائي — Scheduled Snapshots
نسخ احتياطي مجدول لكل مشروع (ساعة/3/6/12/24/7 أيام) مع الاحتفاظ بآخر N نسخة.

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

---

## التطوير المحلي — Development

### المتطلبات
- Node.js 22+ (للتطوير المحلي فقط — في الإنتاج يُبنى داخل Docker)

### بناء وتحقق محلي
```bash
# فحص الأنواع — Frontend
cd frontend && node node_modules\typescript\bin\tsc --noEmit

# بناء الإنتاج — Frontend
cd frontend && node node_modules\vite\bin\vite.js build

# فحص الأنواع — Backend
cd backend && node node_modules\typescript\bin\tsc --noEmit
```

### بناء Docker (للتكامل)
```bash
docker compose build app && docker compose up -d app
```

### الاختبارات
```bash
# تشغيل كامل الاختبارات (الخادم يجب أن يعمل على المنفذ 3000)
cd backend && node --test --test-concurrency=1 "tests/**/*.test.ts"
```

الاختبارات تعمل بشكل تسلسلي — التشغيل المتزامن قد يُثيّر rate limiter.

### أوامر مفيدة
```bash
docker compose ps              # حالة الحزمة
docker compose logs -f app     # متابعة سجلات اللوحة
docker compose down            # إيقاف مع الاحتفاظ بالبيانات
docker compose down -v         # إيقاف مع حذف بيانات الإعدادات
```

---

## هندسة النظام — Architecture

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
│  │  │ (:8100)  │  │  → wsd/workspace image     │   │ │
│  │  └──────────┘  └───────────────────────────┘   │ │
│  │                                                 │ │
│  │  ┌───────────────┐  ┌──────────────────────┐   │ │
│  │  │ opencode web  │  │  Project workspaces   │   │ │
│  │  │ (:4096)       │  │  (bind-mount)         │   │ │
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
