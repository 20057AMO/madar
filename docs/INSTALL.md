# دليل التثبيت — Madar v2 (Beta)

تطبيق `docker compose` بسيط، يعمل محليًا بلا دومين أو SSL إلزامي. كل المطلوب: محرك Docker مع إضافة Compose. أما النشر خارج جهازك فيستخدم **نسخة تطبيق واحدة فقط** أمامها nginx مع TLS، عبر ملفات النشر المُعدّة في `deploy/` و`docker-compose.prod-tls.yml` — لا تُعدّل `docker-compose.yml` يدويًا ([الأمان في النشر](#الأمان-في-النشر--security-in-production-deployment)).

## المتطلبات

- Docker Engine 24+ أو Docker Desktop (بمحرك WSL2 على ويندوز) مع `compose` plugin
- أدوات سطر الأوامر: `git` و`docker` و`curl` و`awk` و`grep` و`cut` و`tr`
- systemd حقيقي كعملية رقم 1 لتثبيت وحدة الإقلاع؛ على WSL2 فعّل systemd أو مرّر `--no-systemd` لتشغيل Madar الآن دون وحدة إقلاع
- منافذ حرة: `3000` للوحة التحكم، و`4097` افتراضيًا للوكيل المصادَق الخاص بـVS Code وOpenCode (أو قيمة `WSD_EMBED_PROXY_PORT` من `.env`). لم تعد `8100`/`4096` منشورة. في التثبيت المحلي ينشر `docker-compose.yml` المنفذين على `0.0.0.0`؛ أما في الإنتاج فيربط `docker-compose.prod-tls.yml` المنفذين على `127.0.0.1`، ويكون nginx وحده المستمع العام على `80`/`443`/`4097` ([الأمان في النشر](#الأمان-في-النشر--security-in-production-deployment))
- مفتاح Ollama Cloud مجاني من https://ollama.com/settings/keys — *اختياري*، يمكن أيضًا استخدام Ollama محلي أو أي مزوّد آخر من واجهة التطبيق
- مفتاح OpenCode Zen مجاني من https://opencode.ai/auth (دخول GitHub، **بدون بطاقة ائتمان**) — *اختياري*، لنماذج Zen المجانية

> لا يحتاج جهازك Node.js أو أي أدوات تطوير — كل شيء يُبنى داخل Docker.

## التثبيت بالسكربت — Recommended

```bash
git clone https://github.com/20057AMO/madar.git madar && cd madar
bash scripts/install.sh
```

السكربت هو الطريق الموصى به على Linux وWSL2 مع Docker Engine 24+ و`compose` v2. يتحقق من `git` و`docker` و`docker compose` و`curl` و`awk` و`grep` و`cut` و`tr`، ومن حرية المنفذين `3000` وقيمة `WSD_EMBED_PROXY_PORT` الفعّالية من `.env` (الافتراضي `4097`) باستخدام `ss` أو `lsof`؛ وينبهك بوضوح إن لم يتوفرا. إذا كانت حاويات Madar تعمل بالفعل يتخطى فحص المنافذ ويخبرك بذلك صراحة. لا يحتاج جهازك Node.js: كل البناء يحدث داخل Docker.

الخيارات:

| الخيار | الوصف |
| --- | --- |
| `--dir PATH` | مسار التثبيت؛ الافتراضي `$MADAR_DIR` أو مجلد المستودع الذي يسكنه السكربت (والد `scripts/`)، مع الرجوع إلى `$PWD` فقط إن كان مستودع Madار |
| `--branch NAME` | الفرع عند استنساخ مستودع `20057AMO/madar`؛ الافتراضي `main` |
| `--no-systemd` | تخطي تثبيت وحدة systemd (تشغيل Madar الآن دون إقلاع تلقائي) |
| `--help` | عرض المساعدة |

سلوك السكربت:

- إن كان المجلد موجودًا، يتحقق أنه نسخة Git من `20057AMO/madar` بمقارنة أصل المستودع بعد تطبيعه (`.git`، الشرطة المائلة الأخيرة، `git@github.com:`، `https://github.com/`، `http://github.com/`) ويرفض أي تعديلات محلية **قبل أي أمر Compose**، ثم ينفّذ `git pull --ff-only`. أعد تشغيل نفس الأمر لتحديث آمن: سحب `--ff-only` ثم إعادة بناء وفحص صحة وتحديث وحدة systemd. لا يُطبع رابط الأصل الخام عند الرفض.
- يثبّت وحدة الإقلاع فقط إن كان systemd هو العملية رقم 1 فعليًا (`/run/systemd/system`)؛ وإلا يحذّر بالعربية ويتخطى تركيب الوحدة دون إكمال تثبيت ناقص. على WSL2 فعّل systemd أو مرّر `--no-systemd`.
- يُسمح بتثبيت Madar واحد فقط على كل مضيف: قبل أي Compose يرفض السكربت وحدة `madar.service` موجودة بـ `WorkingDirectory` مفقود أو مختلف عن مسار التثبيت الحالي.
- ينشئ `.env` من `.env.example` مرة واحدة فقط بصلاحيات مقيّدة (`umask 077`) إن لم يكن موجودًا، ويشترط أن يكون ملفًا عاديًا لا مجلدًا. لا يعيد كتابته، لا يطبع محتواه، ولا يضبط `JWT_SECRET`.
- ينفّذ `docker compose up -d --build`، ثم ينتظر استجابة `{"status":"ok"}` من `http://localhost:3000/api/health` حتى 120 ثانية، مع ضبط مهلة `curl` على الوقت المتبقي من الحد الأقصى قبل كل محاولة. عند الفشل يطبع أمر `docker compose logs --tail=100 app`.
- يثبّت `packaging/systemd/madar.service` بعد استبدال `@MADAR_DIR@` حرفيًا بمسار التثبيت المطلق. بصلاحيات root يثبّت الوحدة بالصلاحية `0644` ويفعّلها مباشرة؛ وإلا يطبع أمر `sudo install … && sudo systemctl daemon-reload && sudo systemctl enable --now madar.service` جاهزًا للتنفيذ. الوحدة لا تحتوي `Restart=`, وتعمل بصلاحيات root مع `NoNewPrivileges=true`؛ لذا يجب أن تكون نسخة Madar مملوكة لـ root ومحمية من تعديل المستخدمين العاديين، بلا ملفات env أو أسرار داخلها. إعادة تشغيل الوحدة تعيد `docker compose up -d` فقط؛ تحديث الكود يتم بإعادة تشغيل سكربت التثبيت.

لإلغاء التثبيت:

```bash
bash scripts/uninstall.sh              # يوقف الحاويات ويحتفظ بالبيانات
bash scripts/uninstall.sh --remove-data # docker compose down -v بعد تأكيد تفاعلي — تدميري
```

ينفّذ uninstall `docker compose down` (أو `down -v` بعد التأكيد) ثم يحاول إيقاف الوحدة وتعطيلها وإزالتها بأفضل جهد. مع `--remove-data` يطلب كتابة `yes` صراحة في أعلى السكربت قبل أي فحص systemd أو Compose أو حذف؛ وإن لم تتم الموافقة أو كانت غير تفاعلية، يلغي فورًا؛ لم يُحذف أي شيء، ولا تلمس الوحدة. عند النجاح يحذف `docker compose down -v` volumes `wsd-data` و`code-server-*` نهائيًا. لا يحذف السكربت مجلد `workspaces/` ولا نسخة المشروع أبدًا، ويطبع مسار مساحة العمل عند الانتهاء. الوحدة تُحذف فقط إن كان `WorkingDirectory` الخاص بها مساويًا لمسار التثبيت المطلوب؛ وإن كانت تشير إلى تثبيت آخر يرفض السكربت الإلغاء حمايةً للتثبيت الآخر.

> سكربت التثبيت أعلاه يثبّت التركيب الأساسي المحلي/الداخلي: `docker-compose.yml` ينشر `3000` و`4097` على `0.0.0.0`، والسكربت لا يفعّل `WSD_TRUST_PROXY` ولا يفتح المنافذ الخام `8100`/`4096`. لا تستخدم هذا التركيب كخطة إنتاج. للنشر خارج جهازك اتبع [الأمان في النشر](#الأمان-في-النشر--security-in-production-deployment): نسخة تطبيق واحدة، `docker-compose.prod-tls.yml` يربط المنفذين على `127.0.0.1`، وnginx هو المستمع العام مع TLS.

## التثبيت اليدوي — Manual

### 1) انسخ المشروع

```bash
git clone https://github.com/20057AMO/madar.git madar
cd madar
```

### 2) أنشئ ملف البيئة

```bash
cp .env.example .env
nano .env   # أو أي محرر
```

| المتغير | مطلوب؟ | الوصف |
| --- | --- | --- |
| `JWT_SECRET` | اختياري | سر توقيع رموز تسجيل الدخول. **اتركه فارغًا**: يولّد التطبيق سرًا عشوائيًا عند أول تشغيل ويحفظه في `data/jwt.secret` داخل volume البيانات (0600) — الجلسات غير قابلة للتزوير وتصمد أمام إعادة التشغيل، ولا يوجد أي سر افتراضي منشور. ولّد قيمة بنفسك فقط للتحكم/التدوير:<br>`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`<br>القيمة الفارغة أو المعروفة أو الأقصر من 32 حرفًا تُرفض (ولا تُصلَح). تغييرها لاحقًا يُنهي كل الجلسات الحالية |
| `WSD_WORKSPACES_HOST_DIR` | اختياري | اتركه فارغًا: الخادم يشتقّ مصدر ربط حاوية التطبيق تلقائيًا من `/proc/self/mountinfo`، فلا يتقادم ولا ينكسر عند إعادة تسمية المجلد أو نقله. اضبطه فقط إذا تعذّر على mountinfo التعبير عن المسار (مشاركة UNC أو مسار توزيع WSL). مثال: `D:/madar/workspaces` أو `/home/me/madar/workspaces`. تظهر القيمة المشتقّة وحالة المسار في `GET /api/ide/status` تحت `workspace` |
| `OLLAMA_API_KEY` | اختياري | مفتاح Ollama Cloud فقط. بدونها يعمل Ollama المحلي أو أي مزوّد آخر |
| `OPENCODE_API_KEY` | اختياري | لتمكين صفحة OpenCode/Zen |
| `WSD_CHAT_MODEL` | اختياري | النموذج الافتراضي للدردشة (افتراضي `qwen3:30b`) |
| `WSD_EMBEDDED_PUBLISH_HOST` | اختياري | واجهة نشر **وكيل الأسطح المدمجة** في التركيب الأساسي (افتراضي `0.0.0.0`) — أي للاستخدام المحلي/الداخلي فقط. الصفحتان لم تعودا تُنشران خامّتين: `code-server` و`opencode` مربوطان على `127.0.0.1` داخل حاوية التطبيق (بلا عنوان على أي شبكة Docker، فلا تصلهما أي حاوية مشروع)، والوصول عبر الوكيل المصادَق على `WSD_EMBED_PROXY_PORT`. في الإنتاج لا تضبط هذا المتغير يدويًا: `docker-compose.prod-tls.yml` يربط المنفذين `3000` و`4097` على `127.0.0.1`، وnginx وحده المستمع العام ([الأمان في النشر](#الأمان-في-النشر--security-in-production-deployment)) |
| `WSD_EMBED_PROXY_PORT` | اختياري | منفذ وكيل الأسطح المدمجة المصادَق (افتراضي `4097`). هو **الطريق الوحيد** إلى VS Code وOpenCode، ويتطلّب جلسة Madar برتبة محرّر فأعلى |
| `OLLAMA_LOCAL_HOST` | اختياري | عنوان Ollama المحلي (افتراضي `http://host.docker.internal:11434`) |
| `WSD_OPENCODE_PORT` | اختياري | منفذ opencode **داخل** الحاوية (افتراضي `4096`) — مربوط على loopback وغير منشور؛ لا تفتحه يدويًا |
| `UBUNTU_VERSION` / `NODE_MAJOR` / `NODE_CHANNEL` | اختياري | معاملات بناء صورة مساحة العمل `wsd/workspace`: إصدار Ubuntu، رقم Node الرئيسي، وقناة Node (افتراضي `26.04` / `24` / `lts` → Ubuntu 26.04 LTS + Node 24 LTS). تُستهلك عند بناء الصورة فقط، لا في حاوية التطبيق (التي تعمل على Node 22). تغييرها لا يحدّث المشاريع القائمة؛ أعد بناء الصورة ثم أعد إنشاء كل مشروع صراحةً |
| `MADAR_BUILD_ID` / `MADAR_BUILD_AT` | اختياري | يُختمان في وسوم `io.madar.workspace.toolchain.*` وفي marker الصورة `/etc/madar/workspace-toolchain.json` (افتراضي `unknown` / `unknown`). إعادة البناء تضبطهما تلقائيًا، ومن تاريخ `builtAt` يُحسب عمر الصورة لتحديد التقادم (30 يومًا) |

مفاتيح باقي المزوّدين (Anthropic / Gemini / Azure / نقاط متوافقة مع OpenAI) تُضاف **من واجهة التطبيق** لاحقًا — لا تُكتب في ملفات.

### 3) ابنِ وشغّل

```bash
docker compose up -d --build
```

سيبني خدمة `app` (اللوحة + المحرر + opencode web) وصورة `wsd/workspace` لحاويات المشاريع. صورة المساحة مبنية على Ubuntu 26.04 LTS + Node 24 LTS.

> **إعادة بناء صورة المساحة وحدها:** شغّل `docker compose build workspace --no-cache` لإعادة بناء `wsd/workspace` من الصفر (مفيد بعد تغيير معاملات الإصدار أو لتحديث الأدوات). لاحظ أن `docker compose build app` يعيد بناء حاوية التطبيق فقط ولا يلمس صورة المساحة. بعد إعادة البناء، أعد إنشاء كل مشروع تريد استخدام الأدوات الجديدة فيه صراحةً (**Recreate**) — لا يوجد تحديث تلقائي للحاويات القائمة.

### 4) أنشئ حسابك

افتح اللوحة:

- اللوحة: `http://localhost:3000`

في أول زيارة ستظهر شاشة **إنشاء الحساب** (اسم مستخدم + كلمة مرور). هذا الحساب الوحيد في النظام — وكلمة المرور نفسها هي التي تحمي إدارة المزوّدين والعمليات الحساسة (مع تأكيد هويته عند كل عملية حساسة).

بعدها أضف مزوّدًا واحدًا على الأقل من صفحة **Providers**، ثم أنشئ أول مشروع من صفحة **Projects**.

## التشغيل التلقائي عند الإقلاع — systemd

القالب `packaging/systemd/madar.service` يستخدم `Type=oneshot` مع `RemainAfterExit=yes`، ويعمل داخل `WorkingDirectory=@MADAR_DIR@` بعد استبدال المتغيّر بمسار التثبيت المطلق عبر `scripts/install.sh`. الوحدة تشغّل `docker compose up -d` و`docker compose down` فقط؛ لا تحتاج Node.js على المضيف ولا تلمس ملفات التطبيق.

بصلاحيات root يثبّت السكربت الوحدة في `/etc/systemd/system/madar.service` بالصلاحية `0644`، ثم ينفّذ `daemon-reload` و`enable --now`، مع حذف الملف المؤقت عبر `trap` عند الخروج. إذا شغّلت السكربت كمستخدم عادي، انسخ أمر `sudo` الذي يطبعُه؛ سيشير إلى ملف في `XDG_RUNTIME_DIR` (أو `TMPDIR`/`/tmp`) يحتوي المسار فقط، بلا أي سر، ويظل حتى تنفّذ الأمر. الوحدة تعمل بصلاحيات root وتستخدم `NoNewPrivileges=true`؛ اجعل نسخة Madار مملوكة لـ root ومحمية من المستخدمين العاديين ولا تضف ملفات env أو أسرارًا. وحدة واحدة تكفي لتشغيل تثبيت Madar على نفس المضيف: يرفض السكربت أي وحدة بـ `WorkingDirectory` مختلف أو مفقود. لتخصيص مسار مختلف استخدم `--dir PATH` بعد إلغاء التثبيت السابق.

أوامر مفيدة:

```bash
sudo systemctl status madar.service
sudo systemctl restart madar.service   # يعيد docker compose up -d فقط، لا يسحب كودًا جديدًا
sudo journalctl -u madar.service -n 100
```

عند نقل التثبيت، ألغِ التثبيت السابق بـ `bash scripts/uninstall.sh --dir OLD_PATH` ثم شغّل `bash scripts/install.sh --dir NEW_PATH`.

## الأمان في النشر — Security in production deployment

Madar **نسخة تطبيق واحدة فقط** في الإنتاج — بلا replicas ولا HA ولا جلسات لاصقة (sticky sessions). السبب: مخزنات JSON بأقفال داخل العملية، ومقبس `/var/run/docker.sock` بصلاحية كتابة، وربط مجلدات `workspaces`، وحالة WebSocket/الطرفية/الشات المرتبطة بحاوية `app`. تشغيل أكثر من نسخة يفقد هذه الضمانات.

### حدود الثقة — Trust boundary

```text
public                 nginx (host)                     app container (loopback only)
:80    ── ACME challenge، ثم redirect إلى HTTPS
:443   ──►  127.0.0.1:3000   (اللوحة + API)
:4097  ──►  127.0.0.1:4097   (الوكيل المصادَق للأسطح المدمجة)
                                   ├─► 127.0.0.1:8080  code-server --auth none
                                   └─► 127.0.0.1:4096  opencode web
```

- **`3000`** هو السطح المصادَق: اللوحة والـ API، ورمز الجلسة (JWT) في `localStorage` يُرسل مع كل طلب.
- **`4097`** هو **الطريق الوحيد** إلى سطحَي تنفيذ الكود: `code-server --auth none` و `opencode web` بلا كلمة مرور، يعملان كـ root داخل حاوية تحمل `/var/run/docker.sock`.
- `8100`/`4096` **لم يعودا منشورَين إطلاقًا** (مربوطان على `127.0.0.1` داخل حاوية التطبيق، بلا عنوان على أي شبكة Docker). لا تفتحهما يدويًا.

### لماذا هذا التركيب — Audit evidence

- **HIGH**: `docker-compose.yml` الأساسي ينشر `3000` و`4097` على `0.0.0.0`. مع `WSD_TRUST_PROXY=1` على تركيب غير محمي يستطيع أي عميل على الشبكة تزوير `X-Forwarded-For` لتجاوز محدّدات المصادقة/الفتح/2FA. لذلك `WSD_TRUST_PROXY=1` **فقط** في `docker-compose.prod-tls.yml`، وبعد أن يصبح nginx المستمع العام الوحيد. لا تضبطه في `.env` للتركيب الأساسي.
- **MEDIUM**: كوكي `madar_embed` يحصل على `Secure` فقط عندما يرى TLS على سطح `:4097`. القاعدة في `embedCookieSecure()` (`backend/src/services/embed-core.ts`): يُضاف `Secure` عندما تكون الوصلة TLS، أو عندما يكون `WSD_TRUST_PROXY=1` **و**وصلوكيل الموثوق بـ `X-Forwarded-Proto: https`. لا يُجعل غير مشروط لأن المتصفح **يُسقط بصمت** كوكي `Secure` وصل عبر `http://`، فيفشل VS Code و opencode لكل مستخدم بلا رسالة خطأ. والعكس: `X-Forwarded-Proto` لا يُقرأ بدون `WSD_TRUST_PROXY=1`، فلا يستطيع عميل تحصين الكوكي أو تعطيله بترويسة مزوّرة.
- **LOW/INFO**: JWT يسافر في سلسلة استعلام مقابس WebSocket (`?token=`). لذلك سجلات وصول nginx يجب أن تستخدم `$uri` **وليس** `$request_uri`، وإلا كُتب الرمز في ملف السجل.

`HttpOnly` + `SameSite=Strict` + بوابة `editor+` + عمر 12 ساعة + إعادة قراءة الدور الحيّ عند كل طلب (فحذف الحساب أو تخفيضه يُسقط الكوكي فورًا) تُحدّ من الضرر لو سُرِّبت قيمة، لكنها **لا تحمي قناة صريحة**: من يقرأ الحزمة يقرأ الكوكي ويستخدمه فورًا. التحكم هو TLS.

### خطوات النشر الإنتاجي

تُعدّ ملفات النشر في `deploy/` و`docker-compose.prod-tls.yml` و`scripts/` من قِبل فريق DevOps؛ لا تُعدّل `docker-compose.yml` يدويًا. استبدل `madar.example.com` و`admin@madar.example.com` بنطاقك وبريدك قبل التنفيذ.

- `MADAR_DOMAIN` و`MADAR_EMAIL` كلاهما مطلوبان؛ مرّرهما إلى `scripts/install.sh --prod-tls` عبر `--domain` و`--email` (أو عبر المتغيّرين في البيئة)، فالسكربت يرفض القيم النموذجية.
- حدّد واجهة `:4097` العامة بـ `--lan-ip <PUBLIC_IPv4>` أو `MADAR_LAN_IP=<PUBLIC_IPv4>`. إن حُذف، يكتشفها السكربت تلقائيًا من جهاز المسار الافتراضي باستخدام `ip -4 -o route show default` ثم `ip -4 -o addr show dev <dev> scope global`؛ ويرفض التثبيت إن تعذّر الكشف أو كانت القيمة ليست IPv4 عامًا صالحًا.
- لا تثبّت `deploy/nginx/madar.conf` الخام كما هو: سطر `listen 4097 ssl;` يربط على كل العناوين ويتصادم مع ربط التطبيق على `127.0.0.1:4097` في التركيب الإنتاجي. المثبّت `--prod-tls` يستبدله بـ `listen <PUBLIC_IPv4>:4097 ssl;` قبل تثبيت الإعداد النهائي.
- `.git/config:3` يحوي `filemode = false` (شائع على ويندوز)، فلا تعتمد على بت التنفيذ في سكربتات `deploy/certbot/`. استدعِ `obtain.sh` بـ `bash` كما يفعل المثبّت، وتعتمد وحدة التجديد على `ExecStart=/bin/sh "@MADAR_DIR@/deploy/certbot/renew.sh"`؛ لا تنفّذ `./deploy/certbot/renew.sh` مباشرة.

```bash
# 1) ثبّت nginx و certbot، وأنشئ مجلد تحدي ACME
sudo apt-get update && sudo apt-get install -y nginx certbot
sudo mkdir -p /var/www/certbot

# 2) شغّل المثبّت الإنتاجي: يطلب الشهادة، ويولّد إعداد nginx النهائي، ويشغّل التركيب، ويثبّت وحدتي systemd
# استبدل النطاق والبريد قبل التنفيذ؛ أضف --lan-ip <PUBLIC_IPv4> إن لم يُكتشف عنوان :4097 تلقائيًا
sudo bash scripts/install.sh --prod-tls --domain madar.example.com --email admin@madar.example.com

# 3) تحقّق من إعداد nginx النهائي الذي ثبّته المثبّت
sudo nginx -t                       # يجب أن ينتهي بـ syntax is ok / test is successful

# 4) تحقق من وحدة تجديد الشهادة
sudo systemctl status certbot-renew.timer --no-pager

# 5) المثبّت شغّل نسخة التطبيق الواحدة بالتراكب الإنتاجي (أعد الأمر عند الحاجة)
docker compose -f docker-compose.yml -f docker-compose.prod-tls.yml up -d --remove-orphans

# 6) تحقق من الربط الفعّال — يجب أن ينتهي بـ exit 0 ورسالة ok
bash scripts/check-prod-binding.sh
bash scripts/check-prod-binding.sh --check-running   # يفحص أيضًا الحاوية الشغّالة wsd-pro

# 7) جدار النار: اسمح بالمضيف بـ 80 و443 و4097 فقط، ولا تسمح بـ 3000 مباشرة
```

`docker-compose.prod-tls.yml` يربط `3000` و`4097` على `127.0.0.1`، ويضبط `WSD_TRUST_PROXY=1` و`WSD_EMBED_PROXY_PORT=4097` و`WSD_EMBEDDED_PUBLISH_HOST=127.0.0.1`، ويضيف `restart: unless-stopped` وحدًّا لحجم سجل الحاوية وفحص صحة. حارسة الربط `scripts/check-prod-binding.sh` تقرأ التركيب الفعّال (`docker compose config`) وتتحقق أن المنفذين مرتبطان على `127.0.0.1` وأن `WSD_TRUST_PROXY=1`؛ أي انحراف يُخرجها بـ exit 1 مع سطر يوضّح السبب.

### عقد إعداد nginx المطلوب

إعداد `deploy/nginx/madar.conf` (الذي تُثبّته في الخطوة 2) يجب أن يحقق ما يلي:

- `:80` يقدّم تحدي ACME تحت `/.well-known/acme-challenge/` ثم يعيد التوجيه إلى HTTPS؛ لا يمرّر حركة التطبيق على HTTP صريح.
- `:443` يوكّل إلى `127.0.0.1:3000`؛ `:4097` على نفس المضيف يوكّل إلى `127.0.0.1:4097`. كوكي `madar_embed` مقيَّد بالمضيف (لا يميّز المنافذ)، و opencode يقدّم مسارات مطلقة (`/assets/...`) لذلك يُستخدم **منفذ TLS ثانٍ** وليس بادئة مسار.
- ترويسات WebSocket (`Upgrade`/`Connection`) و`proxy_http_version 1.1` و`proxy_read_timeout` طويلة لمقابس IDE وopencode والطرفية والشات؛ بلا ترقية تنتهي الجلسة عند أول إطار.
- `proxy_set_header X-Forwarded-Proto $scheme` حتى يرى `embedCookieSecure()` HTTPS ويُصدر الكوكي بـ `Secure`.
- `client_max_body_size 256m` — حد استيراد لقطة المشروع نفسه 200 ميغابايت (`backend/src/index.ts`)، و`256m` يترك هامشًا لبيانات multipart وترويسات الرفع؛ وأي قيمة أقل من حجم اللقطة تُرجع 413. مرفقات شات الفريق محدّدة بـ 10 ميغابايت (`chat-team-core.ts`)، ومرفقات شات المشروع بـ 4 ميغابايت و5 ملفات (`ws-chat.ts`).
- سجل الوصول بصيغة تستخدم `$uri` (وليس `$request_uri`) في حقل المسار، وإلا كُتب الرمز في السجل؛ والترويسة `X-Forwarded-For: $remote_addr` تمرّر عنوان العميل من القفزة الموثوقة فقط.

### ملاحظات اختبار نزيهة

- السكربت الأساسي `scripts/install.sh` يثبّت التركيب المحلي فقط؛ التحويل إلى الإنتاج يتم بالخطوات أعلاه على نسخة واحدة.
- اختبارات `*-core.test.ts` (الوحدات الصرفة) تعمل داخل حاوية `WSD_TESTING=0` الحالية. المجموعة الكاملة المتسلسلة (`node --test --test-concurrency=1 "tests/**/*.test.ts"`) تحتاج حاوية suite منفصلة بـ `WSD_TESTING=1`؛ لا تدّعِ أنها نجحت في حاوية الإنتاج.
- في هذه البيئة تعذّر تشغيل `scripts/check-prod-binding.sh` بنجاح لأن `bash` هنا من WSL بلا تكامل Docker (`The command 'docker' could not be found in this WSL 2 distro`). تحققت من منطق السكريت ثابتًا: عند نجاح `docker compose config` وتحقق الربط يطبع `ok: ...` ويخرج بـ 0؛ لم ينفّذ فعليًا هنا.

## طريقة الاستخدام

1. **إنشاء مشروع**: أدخل الاسم (والمنافذ اختياريًا مثل `8080,8081`). يُنشأ مجلد `workspaces/<slug>` وحاوية باسم `wsd-<slug>` على منفذها الخاص.
2. **شات AI داخل المشروع**: تبويب **AI Chat** في صفحة المشروع — دردشة تفهم بنية المشروع وتبحث في ملفاته تلقائيًا، مع ردود متدفقة ومرفقات وجلسات محفوظة وزر إيقاف.
3. **الوكلاء**: صفحة **Agents** — وكلاء بأدوات (قراءة/كتابة ملفات، تنفيذ أوامر، استعراض شجرة المشروع)، بدعم RTL/LTR وقوالب جاهزة.
4. **المحرر**: زر **VS Code** في الشريط الجانبي يفتح محرر code-server مدمجًا، وهو مُشغّل بدون كلمة مرور (`--auth none`) — فلا يطلب منك أي كلمة مرور عند الفتح.
5. **OpenCode**: زر **opencode** في الشريط الجانبي يفتح الواجهة الرسمية — الجلسات تعمل من `/workspaces`.
6. **المزوّدون**: صفحة **Providers** لإضافة/فحص المزوّدين، مع قفل أمان اختياري وسجل تدقيق ونسخ احتياطية للإعدادات.
7. **الرفع**: تبويب **Upload** داخل المشروع — رفع ملفات إلى `workspaces/<slug>`.

## ملاحظات

- حاويات المشاريع لا تُشغّل خدمات تلقائيًا (`sleep infinity`)؛ شغّل خادمك عبر الطرفية أو المحرر — المنفذ المحدد عند الإنشاء يجب أن يكون مُعرّضًا.
- بياناتك: مجلد `./workspaces` (ملفات المشاريع) + volume اسمه `wsd-data` (الحساب والمزوّدون وجلسات الشات). كلاهما يبقى بعد إعادة التشغيل وإعادة البناء.
- لا يوجد متصفح داخل الحاوية (لتوفير الرام)؛ معاينات المشاريع تُفتح كروابط مباشرة في متصفحك.
- الخروج التلقائي عند الخمول قابل للضبط من الإعدادات (إيقاف / 30 / 60 / 120 دقيقة).

## استكشاف الأخطاء

| المشكلة | الحل |
| --- | --- |
| الحاوية تعيد التشغيل باستمرار | افحص `docker compose logs app` — غالبًا السبب في `WSD_WORKSPACES_HOST_DIR` أو صلاحيات volume البيانات |
| إنشاء المشروع يفشل | تأكد أن مقبس `/var/run/docker.sock` مسموح للحاوية `app`. إن كانت رسالة الخطأ تذكر workspaces، فراجع `workspace.hint` في `GET /api/ide/status` — الخادم يرفض الإنشاء صراحةً إذا كان المسار غير قابل للتحديد أو المجلد تالف بدل إنشاء حاوية على ربط خاطئ |
| ملفات المشروع لا تظهر داخل حاويته | راجع `workspace.hostPath` و `workspace.source` في `GET /api/ide/status`؛ `source: mountinfo` يعني أن المسار مشتقّ تلقائيًا. اضبط `WSD_WORKSPACES_HOST_DIR` فقط لمشاركة UNC أو مسار WSL |
| المحرر لا يفتح | المحرر لم يعد يُفتح على منفذ `8100` — افتح `/#/ide` من اللوحة، فهي تمر عبر الوكيل المصادَق على `4097`. تأكد أن `app` يعمل وأن المنفذ `4097` غير محجوب، وأن حسابك برتبة **محرّر فأعلى** (المشاهد يرى رسالة "يحتاج صلاحيات محرّر") |
| الإعدادات لا تطبَّق داخل المحرر | مجلد `code-server-data` (المركّب على `/root/.local/share/code-server`) **يحجب** ملف إعدادات المستخدم المخبوز في الصورة — فـ VS Code يقرأ `settings.json` من `<user-data-dir>/User/` وليس من `~/.config/code-server` (هذا المجلد خاص بـ `config.yaml` فقط)، لذا يعيد `entrypoint.sh` مزامنة كل إقلاع: ينسخ نسخة `settings.json.madar-backup-<stamp>` ثم يستبدل الملف بشكل ذرّي ويشغّل `verify`. لاحظ السطر `Madar: managed IDE config already at stamp … — nothing to sync` في `docker compose logs app` — إن لم يظهر، فالمزامنة جرت. وللتعديل اليدوي مرة واحدة، انسخ الملف إلى الـ volume (`docker cp settings.json wsd-pro:/root/.local/share/code-server/User/settings.json`) مع العلم أن الإقلاع التالي سيعيد مزامنة المفاتيح المُدارة |
| لوحة TODOs فارغة أو خطأ `Failed to find vscode-ripgrep` | إضافة `gruntfuggly.todo-tree` تقرأ مفتاح `todo-tree.ripgrep.ripgrep` وتبحث عن `rg` محليًا؛ المفتاح يجب أن يشير إلى `/usr/lib/code-server/lib/vscode/node_modules/@vscode/ripgrep-universal/bin/linux-x64/rg` (المسار المضمَّن فعليًا). أي **اسم مفتاح خاطئ** صامت تمامًا — تُحفظ القيمة لكن الإضافة لا تقرأها. تحقّق من الأسماء في `package.json` الخاص بالإضافة داخل الحاوية: `/root/.local/share/code-server/extensions/gruntfuggly.todo-tree-*/package.json` ← `contributes.configuration.properties`، وتحقّق أيضًا من **نوع القيمة** (`todo-tree.filtering.includeGlobs` مصفوفة، لا نص) |
| لوحة TODOs فارغة مع رسالة `rg: regex parse error: … look-around … not supported` | التعبير النمطي المنسَّق ينتهي بنظرة أمامية `(?=[(:\s]|$)`، ومحرك ripgrep الافتراضي يرفضها — و Todo Tree **يستخدم rg فقط** في مسح مساحة العمل (لا بديل JS)، فالإضافة تجد **صفرًا** عناصر. الحل: أضف `--pcre2` إلى `todo-tree.ripgrep.ripgrepArgs` (قيمتنا `--max-columns=1000 --no-config --pcre2`). تحقّق أن rg المضمَّن يدعمه: `docker exec wsd-pro /usr/lib/code-server/lib/vscode/node_modules/@vscode/ripgrep-universal/bin/linux-x64/rg --version` يجب أن يعرض `features:+pcre2` |
| صورة مساحة العمل قديمة أو أدواتها لا تطابق المطلوب | الصورة مبنية على Ubuntu 26.04 LTS + Node 24 LTS، وتُعدّ قديمة عند بلوغ 30 يومًا من `builtAt` في marker الصورة. أعد بناءها بـ `docker compose build workspace --no-cache` ثم أعد إنشاء كل مشروع صراحةً لتطبيق الأدوات الجديدة؛ لا يوجد تحديث تلقائي للحاويات القائمة. للتحقق، راجع الوسوم `io.madar.workspace.toolchain.*` أو الـ marker `/etc/madar/workspace-toolchain.json` داخل حاوية مشروع |
| مستكشف المصادر يعلّق على "Scanning folder for Git repositories…" | هذه العَرَض لـ `vscode.git-base` مفقود: تعتمد إضافة Git عليه عبر `extensionDependencies`، وحذفه يوقف مستكشف المصادر. أصلحه بتشغيل `/usr/local/share/madar/ide-hardening.sh apply && verify` داخل حاوية `app` — السكربت يستعيده من النسخة المحفوظة في `/opt/madar/ide-builtin` ويعيد بناء الإغلاق (closure) آليًا |
| Copilot يظهر من جديد أو يتضخم حجم صورة المحرر | `dpkg -i` (تحديث المكوّنات أو إعادة التطبيق عند الإقلاع) يستعيد `/usr/lib/code-server` الأصلي. أُغلقت هذه الثغرة: كل مسارات `dpkg` تشغّل `ide-hardening.sh apply && verify`، والإقلاع يشغّل `verify` أيضًا. تحقّق بـ `docker exec wsd-pro /usr/local/share/madar/ide-hardening.sh verify` — يجب أن ينتهي بـ `exit 0`، وأن يكون `@github` أصغر من 2 ميغابايت |
| opencode لا يعمل | افتح `/#/opencode` من اللوحة (عبر الوكيل المصادَق على `4097`) وافحص `docker compose logs app`؛ أضف `OPENCODE_API_KEY` إن لم يكن مضبوطًا |
| الدردشة تخطئ | افتح **Providers** واضغط فحص الاتصال للمزوّد — الرسالة تميز بين خطأ مفتاح وحصة ومنفذ |
| إنتاج: اللوحة تُفتح على `http://host:3000` مباشرة | تركيب الإنتاج لم يُطبَّق. شغّل `docker compose -f docker-compose.yml -f docker-compose.prod-tls.yml up -d --remove-orphans` ثم `bash scripts/check-prod-binding.sh` (يجب exit 0)، وافتح اللوحة عبر `https://madar.example.com` فقط |
| إنتاج: iframe لـ VS Code/opencode ميت والكوكي بلا `Secure` | nginx لم يمرّر `X-Forwarded-Proto: https` أو `WSD_TRUST_PROXY` لم يُضبط في التراكب الإنتاجي. تحقق أن `sudo nginx -t` سليم، وأن `docker-compose.prod-tls.yml` مطبَّق، وأعد فتح الصفحة؛ الكوكي القديم بلا `Secure` لا يُحصَّن بأثر رجعي — سجّل دخولًا جديدًا |
| إنتاج: 429 عشوائية على تسجيل الدخول/الفتح/2FA | `WSD_TRUST_PROXY=1` مفعّل أمام وكيل غير موثوق، فيرى المحدّد عنوان الوكيل بدل العميل. تأكد أن nginx هو المستمع العام الوحيد وأن `:3000`/`:4097` مرتبطان على `127.0.0.1` (`check-prod-binding.sh`) |
| استيراد لقطة project يرجع 413 | رفع nginx (`client_max_body_size`) أقل من 256m. اضبطه إلى `256m` كما في `deploy/nginx/madar.conf`؛ حد استيراد التطبيق نفسه 200 ميغابايت، و`256m` يترك هامشًا لبيانات multipart وترويسات الرفع |
| JWT يظهر في سجل nginx | الإعداد يستخدم `$request_uri` وهو يُسجّل سلسلة الاستعلام الكاملة بما فيها `?token=`. استبدله بـ `$uri` في صيغة `log_format` وأعد `sudo nginx -t && sudo systemctl reload nginx`، ثم طهّر السجل القديم |
| تجديد الشهادة يفشل أو انتهت الشهادة | تحقق من `sudo systemctl status certbot-renew.timer` وسجلات systemd المتعلقة بـ certbot (`sudo journalctl -u 'certbot*' -n 100`)، وأن `/var/www/certbot` قابل للكتابة وأن المنفذ `80` مفتوح لتحدي ACME. أعد `MADAR_DOMAIN=madar.example.com MADAR_EMAIL=admin@madar.example.com bash deploy/certbot/obtain.sh` عند الحاجة (استبدل القيمتين النموذجيتين)، وتذكّر أن وحدة التجديد تستدعي `renew.sh` عبر `/bin/sh` لا تنفيذًا مباشرًا |
| iframe ميت بعد تحديث الشهادة | أعد تحميل الصفحة؛ إن استمر، تحقق أن nginx أعاد قراءة الشهادة (`sudo systemctl reload nginx`) وأن `WSD_TRUST_PROXY=1` لا يزال ساريًا في الحاوية |
| نُسيت كلمة المرور | احذف volume البيانات لإعادة ضبط كل شيء: `docker compose down -v` (**يمسح** الحساب والمزوّدين والجلسات — ملفات المشاريع تبقى) |

## إيقاف

```bash
docker compose down        # إيقاف مع الاحتفاظ بالبيانات
docker compose down -v     # إيقاف مع حذف بيانات الإعدادات والجلسات
```
