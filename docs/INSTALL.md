# دليل التثبيت — Madar v2 (Beta)

تطبيق `docker compose` بسيط، بدون دومين وبدون SSL. كل المطلوب: محرك Docker مع إضافة Compose.

## المتطلبات

- Docker Engine 24+ أو Docker Desktop (بمحرك WSL2 على ويندوز) مع `compose` plugin
- منافذ حرة: `3000` للوحة التحكم، `4097` للوكيل المصادَق الخاص بـVS Code وOpenCode. لم تعد `8100`/`4096` منشورة. كلاهما يُنشر على `0.0.0.0` — في أي نشر خارج جهازك، أنهِ TLS أمامهما معًا ([الأمان في النشر](#الأمان-في-النشر--security-in-production-deployment))
- مفتاح Ollama Cloud مجاني من https://ollama.com/settings/keys — *اختياري*، يمكن أيضًا استخدام Ollama محلي أو أي مزوّد آخر من واجهة التطبيق
- مفتاح OpenCode Zen مجاني من https://opencode.ai/auth (دخول GitHub، **بدون بطاقة ائتمان**) — *اختياري*، لنماذج Zen المجانية

> لا يحتاج جهازك Node.js أو أي أدوات تطوير — كل شيء يُبنى داخل Docker.

## خطوات التثبيت

### 1) انسخ المشروع

```bash
git clone <repo-url> madar
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
| `WSD_EMBEDDED_PUBLISH_HOST` | اختياري | الواجهة التي يُنشر عليها **وكيل الأسطح المدمجة** (افتراضي `0.0.0.0`). الصفحتان لم تعودا تُنشران خامّتين: `code-server` و`opencode` مربوطان على `127.0.0.1` داخل حاوية التطبيق (بلا عنوان على أي شبكة Docker، فلا تصلهما أي حاوية مشروع)، والوصول عبر الوكيل المصادَق على `WSD_EMBED_PROXY_PORT`. تضييقه إلى `127.0.0.1` يجعل المحرّر وOpenCode محليَّي الجهاز فقط |
| `WSD_EMBED_PROXY_PORT` | اختياري | منفذ وكيل الأسطح المدمجة المصادَق (افتراضي `4097`). هو **الطريق الوحيد** إلى VS Code وOpenCode، ويتطلّب جلسة Madar برتبة محرّر فأعلى |
| `OLLAMA_LOCAL_HOST` | اختياري | عنوان Ollama المحلي (افتراضي `http://host.docker.internal:11434`) |
| `WSD_OPENCODE_PORT` | اختياري | منفذ opencode **داخل** الحاوية (افتراضي `4096`) — مربوط على loopback وغير منشور؛ لا تفتحه يدويًا |

مفاتيح باقي المزوّدين (Anthropic / Gemini / Azure / نقاط متوافقة مع OpenAI) تُضاف **من واجهة التطبيق** لاحقًا — لا تُكتب في ملفات.

### 3) ابنِ وشغّل

```bash
docker compose up -d --build
```

سيبني خدمة `app` (اللوحة + المحرر + opencode web) وصورة `wsd/workspace` لحاويات المشاريع.

### 4) أنشئ حسابك

افتح اللوحة:

- اللوحة: `http://localhost:3000`

في أول زيارة ستظهر شاشة **إنشاء الحساب** (اسم مستخدم + كلمة مرور). هذا الحساب الوحيد في النظام — وكلمة المرور نفسها هي التي تحمي إدارة المزوّدين والعمليات الحساسة (مع تأكيد هويته عند كل عملية حساسة).

بعدها أضف مزوّدًا واحدًا على الأقل من صفحة **Providers**، ثم أنشئ أول مشروع من صفحة **Projects**.

## الأمان في النشر — Security in production deployment

المنفذان `3000` و`4097` يُنشران على `0.0.0.0` (انظر `docker-compose.yml`)، أي أنهما في متناول كل جهاز على الشبكة. **في أي نشر يتجاوز جهاز المطوّر، أنهِ TLS أمام المنفذين معًا** — terminate TLS in front of **both** `:3000` (اللوحة + API) و `:4097` (الوكيل المصادَق لـ VS Code و OpenCode).

### لماذا المنفذان معًا وليس واحدًا

- **`3000`** هو السطح المصادَق: اللوحة والـ API، ورمز الجلسة (JWT) يعيش في `localStorage` ويُرسل مع كل طلب.
- **`4097`** هو **الطريق الوحيد** إلى سطحَي تنفيذ الكود: `code-server --auth none` و `opencode web` بلا كلمة مرور، يعملان كـ root داخل حاوية تحمل `/var/run/docker.sock`.
- ترويس `3000` وحده يترك سطح تنفيذ كود كامل على قناة صريحة. ولا يوجد منفذ ثالث لترويسه: `8100` و `4096` **لم يعودا منشورَين إطلاقًا** (مربوطان على `127.0.0.1` داخل حاوية التطبيق، وبلا عنوان على أي شبكة Docker).

### نموذج التهديد الصادق — Honest threat model

بدون TLS، من يستطيع اعتراض مسار الشبكة (ARP spoof، نقطة وصول لاسلكية خبيثة، جهاز على نفس الشبكة المحلية) يقرأ ما يمرّ نصًّا صريحًا: **رمز الجلسة** من `localStorage` عبر `:3000`، **وكوكي `madar_embed`** عبر `:4097`، وكل بايت من الملفات وواجهات الـ API. لذلك **غياب `Secure` على الكوكي ليس ثغرة منفصلة يمكن إصلاحها** — هو غياب الضابط الوحيد الذي كان TLS يوفّره. لا تغيير برمجي يجعل قيمة تُقرأ على السلك غير قابلة للقراءة.

### لماذا الكوكي ليس `Secure` دائمًا

القاعدة في `embedCookieSecure()` (`backend/src/services/embed-core.ts`): يُضاف `Secure` فقط عندما تكون **الوصلة نفسها** TLS، أو عندما يكون المشغّل قد فعّل `WSD_TRUST_PROXY=1` **و**أبلغ الوكيل الموثوق بـ `X-Forwarded-Proto: https`. والسبب عدم جعله غير مشروط: التثبيت الموصوف هنا HTTP صريح، والمتصفح **يُسقط بصمت** كوكي `Secure` يصل عبر `http://` — فيفشل VS Code و opencode لكل مستخدم على الشبكة بلا أي رسالة خطأ. والعكس صحيح أيضًا: `X-Forwarded-Proto` لا يُقرأ إطلاقًا بدون `WSD_TRUST_PROXY=1`، فعميل على الشبكة لا يستطيع تحصين الكوكي (أو تعطيله) بترويسة مزوّرة منفردًا.

> `WSD_TRUST_PROXY=1` يضبط أيضًا `trust proxy` للطلب الواحد، فيرى محدّدات المعدّل (rate limiting) عناوين العملاء الحقيقية بدل عنوان الوكيل. اضبطه **فقط** عندما يكون هناك قفزة واحدة موثوقة فعلًا أمام التطبيق — راجع صياغته في `.env.example`.

### مثال تطبيقي — Caddy

```caddyfile
# /etc/caddy/Caddyfile
# TLS أمام المنفذين معًا. Caddy يمرّر ترويسات WebSocket الترقية تلقائيًا،
# فلا حاجة لإعداد Upgrade/Connection يدويًا.

# 1) اللوحة + API  ->  منفذ الحاوية 3000
madar.example.com {
	reverse_proxy 127.0.0.1:3000
}

# 2) وكيل الأسطح المدمجة  ->  منفذ الحاوية 4097
#    نفس اسم المضيف على **منفذ TLS ثانٍ**، وليس بادئة مسار: كوكي madar_embed
#    مقيَّد بالمضيف (الكوكي لا يميّز المنافذ) فتجده في 4097، و opencode يقدّم
#    مسارات مطلقة (/assets/...) فلا يحتمل العمل تحت بادئة مسار.
madar.example.com:8443 {
	reverse_proxy 127.0.0.1:4097
}
```

### مثال تطبيقي — nginx

```nginx
# /etc/nginx/conf.d/madar.conf
map $http_upgrade $madar_connection_upgrade {
    default upgrade;
    ''      close;
}

# 1) اللوحة + API
server {
    listen 443 ssl;
    server_name madar.example.com;
    ssl_certificate     /etc/letsencrypt/live/madar.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/madar.example.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;   # <- https: يجعل كوكي madar_embed يُصدر بـ Secure
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $madar_connection_upgrade;
    }
}

# 2) وكيل الأسطح المدمجة — نفس المضيف، منفذ TLS ثانٍ
server {
    listen 8443 ssl;
    server_name madar.example.com;
    ssl_certificate     /etc/letsencrypt/live/madar.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/madar.example.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:4097;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # code-server و opencode كلاهما يستخدم WebSocket؛ بلا ترويسة Upgrade
        # تنتهي الجلسة عند أول إطار.
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $madar_connection_upgrade;
        proxy_read_timeout 3600s;          # مقابس IDE و opencode طويلة العمر
    }
}
```

ثم في `.env` على المضيف:

```bash
# قفزة موثوقة واحدة فعلًا أمام التطبيق: عنوان العميل الحقيقي للمعدّدات
# + تمرير X-Forwarded-Proto: https، فيُصدر madar_embed بـ Secure.
WSD_TRUST_PROXY=1
# الوكيل المصادَق من المضيف المحلي وحده — لا أحد على الشبكة يتصل به مباشرة.
WSD_EMBEDDED_PUBLISH_HOST=127.0.0.1
```

**ملاحظتان نزيهتان:**

- ترويس `X-Forwarded-Proto` يجب أن يمرّ كما هو. الوكيل يقرأ قيمته **فقط** مع `WSD_TRUST_PROXY=1`؛ بدونه يُصدر الكوكي بلا `Secure` على HTTPS، فتبقى قيمة قابلة للقراءة على مسار الشبكة.
- `WSD_EMBEDDED_PUBLISH_HOST=127.0.0.1` يسحب `4097` إلى المضيف المحلي. لكن نشر `3000` مثبَّت في `docker-compose.yml` على `0.0.0.0` وليس له متغير بيئة: لإزالته من الشبكة كليًا اربطه على `127.0.0.1:3000:3000` في `docker-compose.yml` وأعد التشغيل. حتى ذلك الحين، `:3000` يبقى موجودًا بنص صريح.

### ما ليس بديلًا عن TLS

`HttpOnly` + `SameSite=Strict` + بوابة `editor+` + عمر 12 ساعة + إعادة قراءة الدور الحيّ عند كل طلب (فحذف الحساب أو تخفيضه يُسقط الكوكي فورًا) — كلها **تُحدّ من الضرر** لو سُرِّبت قيمة، لكنها **لا تحمي قناة صريحة**: من يقرأ الحزمة يقرأ الكوكي نفسه، ويستخدمه فورًا قبل أن يلحقه أي شرط. التحكم الحقيقي هو TLS. أما المنافذ الخام `8100`/`4096` فلا حاجة إلى أي ترويس لأنها لم تعد منشورة.

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
| opencode لا يعمل | افتح `/#/opencode` من اللوحة (عبر الوكيل المصادَق على `4097`) وافحص `docker compose logs app`؛ أضف `OPENCODE_API_KEY` إن لم يكن مضبوطًا |
| الدردشة تخطئ | افتح **Providers** واضغط فحص الاتصال للمزوّد — الرسالة تميز بين خطأ مفتاح وحصة ومنفذ |
| نُسيت كلمة المرور | احذف volume البيانات لإعادة ضبط كل شيء: `docker compose down -v` (**يمسح** الحساب والمزوّدين والجلسات — ملفات المشاريع تبقى) |

## إيقاف

```bash
docker compose down        # إيقاف مع الاحتفاظ بالبيانات
docker compose down -v     # إيقاف مع حذف بيانات الإعدادات والجلسات
```
