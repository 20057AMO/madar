# قائمة تحقق نشر Madar الإنتاجي خلف nginx مع TLS

هذه القائمة للمثبّت الذي يسلّم نسخة Madar واحدة على مضيف حقيقي خلف nginx، مع TLS على `:443` و`:4097`، بعد اكتمال إعدادات النشر في المستودع.

> **مصدر الحقيقة:** [الأمان في النشر — Security in production deployment](INSTALL.md#الأمان-في-النشر--security-in-production-deployment). لا تنسخ تفاصيله المطوّلة هنا؛ ارجع إليه عند أي خلاف.
> **تحذير:** هذه قائمة تحقق **يجب تنفيذها على المضيف الحقيقي**. ما جرى قبل كتابتها كان فحصًا ثابتًا/محليًا للملفات فقط؛ لم يُنفَّذ نشر فعلي ولا إصدار شهادة هنا.
> **ابدأ ب:** `bash scripts/install.sh --help`، ثم القسم 1. استبدل `<DOMAIN>` و`<EMAIL>` و`<PUBLIC_IPv4>` و`<INSTALL_DIR>` بقيمك الحقيقية؛ و`<PUBLIC_IPv4>` يجب أن يكون عنوان IPv4 عامًا مُسنَّدًا فعليًا إلى المضيف، فالعناوين الخاصة وفق RFC1918 مرفوضة. المثبّت يرفض `madar.example.com` و`admin@madar.example.com` النموذجيتين صراحةً؛ لا تنسخهما في أمر قابل للتنفيذ، ولا تضع أسرارًا في هذا الملف.

المسار: 1) المتطلبات · 2) التنفيذ · 3) بوابة التحقق · 4) تجديد الشهادة · 5) استكشاف مختصر.

## 1) متطلبات مختصرة

- [ ] مضيف Linux بصلاحية root، مع `ip` و`install` و`nginx` و`certbot` و`systemctl` وDocker/Compose.
- [ ] nginx هو المستمع العام الوحيد: `:80` لتحدي ACME ثم تحويل إلى HTTPS، `:443` إلى `127.0.0.1:3000`، `:4097` إلى `127.0.0.1:4097`.
- [ ] نسخة تطبيق واحدة فقط — بلا replicas ولا HA ولا جلسات لاصقة؛ السبب (مخازن JSON بأقفال داخل العملية، `docker.sock` للكتابة، ربط `workspaces`، حالة WS/طرفية/شات مرتبطة بالحاوية) في [INSTALL.md](INSTALL.md#الأمان-في-النشر--security-in-production-deployment). المنفذان `8100`/`4096` غير منشورَين.
- [ ] لا تضبط `WSD_TRUSTED_PROXIES` أو `WSD_TRUST_PROXY` في `.env`؛ التراكب `docker-compose.prod-tls.yml` يضبط `WSD_TRUSTED_PROXIES` وحده بعد تأمين المنافذ. المتغير `WSD_TRUST_PROXY` مهمل.
- [ ] `.git/config` يحوي `filemode = false`؛ استدعِ سكربتات `deploy/certbot/` عبر `bash`/`/bin/sh` لا بالتنفيذ المباشر.

## 2) التنفيذ

- [ ] ثبّت nginx و certbot، وأنشئ مجلد تحدي ACME:

```bash
sudo apt-get update && sudo apt-get install -y nginx certbot
sudo mkdir -p /var/www/certbot
```

- [ ] راجع الواجهة، ثم شغّل المثبّت الإنتاجي بالقيم الحقيقية. `--lan-ip` اختياري فقط إن أعاد الكشف التلقائي من جهاز المسار الافتراضي عنوانًا عامًا مقبولًا؛ نجاح الكشف لا يكفي إن كان العنوان المكتشف خاصًا (`10.*` أو `172.16-31.*` أو `192.168.*`)، فالمثبّت يرفضه بالرسالة `تعذّر تحديد عنوان IPv4 عام صالح؛ مرّره عبر --lan-ip أو MADAR_LAN_IP.`: إن فشل الكشف أو أعاد عنوانًا خاصًا، مرّر `--lan-ip` صراحةً بعنوان IPv4 عام مُسنَّد فعليًا إلى المضيف:

```bash
bash scripts/install.sh --help
sudo bash scripts/install.sh --prod-tls --dir <INSTALL_DIR> --domain <DOMAIN> --email <EMAIL>   # أضف --lan-ip <PUBLIC_IPv4> إن فشل الكشف التلقائي أو أعاد عنوانًا خاصًا
```

- [ ] المثبّت ينفّذ: `obtain.sh`، ثم `docker compose -f docker-compose.yml -f docker-compose.prod-tls.yml config --quiet`، ثم `up -d --build --remove-orphans`، ثم انتظار `http://127.0.0.1:3000/api/health` حتى 120 ثانية، ثم تثبيت إعداد nginx النهائي، ثم `check-prod-binding.sh --check-running`، ثم وحدتَي `madar.service` و`certbot-renew.timer` تحت `/etc/systemd/system/` بصلاحية `0644`.

## 3) بوابة التحقق الإلزامية

كل سطر أدناه شرط تسليم؛ لا تكتفِ بنجاح البناء.

### nginx و systemd

- [ ] `sudo nginx -t` ينتهي بـ `syntax is ok` / `test is successful`.
- [ ] الإعداد النهائي المثبّت في `/etc/nginx/conf.d/madar.conf` يحوي `<DOMAIN>` في `server_name` ومساري الشهادة و`frame-ancestors`، و`listen <PUBLIC_IPv4>:4097 ssl;`، و`client_max_body_size 256m`، و`$uri` في صيغة السجل (ليس `$request_uri`)، و`X-Forwarded-Proto https`، وtimeouts لـ WebSocket. لا تبقّى قيمة `madar.example.com` في الملف.
- [ ] `sudo systemctl status madar.service` و`sudo systemctl status certbot-renew.timer --no-pager` يظهران active/enabled.

### الربط والمنافذ

- [ ] `bash scripts/check-prod-binding.sh --dir <INSTALL_DIR> --check-running` يخرج بـ exit 0 ورسالة `ok: app ports 3000 and 4097 are bound to 127.0.0.1 and WSD_TRUSTED_PROXIES is configured`. إن طبع `skip: container wsd-pro is not running; runtime binding not checked` فالحاوية غير شغّالة؛ شغّلها ثم أعد الفحص.
- [ ] لا يوجد ربط عام على `0.0.0.0:3000` أو `0.0.0.0:4097` في التركيب الفعّال؛ ولم تُفتح `8100`/`4096` يدويًا.

### TLS على 443 و4097

- [ ] `curl -fsS https://<DOMAIN>/api/health` يعيد `{"status":"ok"}` بلا تحذير شهادة.
- [ ] `curl -sS https://<DOMAIN>:4097/` ينفّذ مصافحة TLS بشهادة صالحة للنطاق نفسه. أي استجابة HTTP (مثل 401/403) متوقعة لأن الوكيل يتطلب جلسة محرّر؛ خطأ TLS يعني أن `:4097` لم يُنهُ TLS.
- [ ] `curl -sSI http://<DOMAIN>/ | grep -i '^location:'` يجب أن يُظهر `https://...`؛ لا تُقدَّم حركة التطبيق على HTTP صريح.

### جدار النار

- [ ] جدار النار يسمح من الشبكة العامة بـ `80` و`443` و`4097` على المضيف فقط، ويمنع `3000` و`8100` و`4096` مباشرة. مصدر الحقيقة يذكر النتيجة دون أمر جدار محدد؛ تحقّق من المخرج: افتح `https://<DOMAIN>/api/health` و`https://<DOMAIN>:4097/` من جهاز خارج المضيف، وتأكد أن `http://<PUBLIC_IPv4>:3000/` لا يفتح.

### اللوحة والأسطح المدمجة

- [ ] `curl -fsS http://127.0.0.1:3000/api/health` يعيد `{"status":"ok"}` من على المضيف؛ المسار مسجَّل قبل `authMiddleware` فلا يحتاج رمزًا.
- [ ] بحساب **محرّر فأعلى**، افتح `/#/ide` و`/#/opencode` من اللوحة: الإطار يعمل، ولا تظهر رسالة "يحتاج صلاحيات محرّر"، والكوكي `madar_embed` يحصل على `Secure`.
- [ ] بحساب **مشاهد** تُرفض بوابة فتح الأسطح المدمجة ويظهر الإطار رسالة "يحتاج صلاحيات محرّر"؛ لا تمنح صلاحية أعلى لتجاوز الفحص.

## 4) تجديد الشهادة

- [ ] `sudo systemctl status certbot-renew.timer --no-pager` يظهر مفعّلاً؛ الجدول `OnCalendar=*-*-* 00,12:17:00` مع `Persistent=true` (مرتان يوميًا).
- [ ] الوحدة تستدعي `/bin/sh "<INSTALL_DIR>/deploy/certbot/renew.sh"`؛ السكربت يقبل فقط `--reload-nginx` الذي يستخدمه `deploy-hook`. لا تنفّذ `./deploy/certbot/renew.sh` مباشرة.
- [ ] عند فشل التجديد: `sudo journalctl -u 'certbot*' -n 100`، وتأكد أن `/var/www/certbot` قابل للكتابة وأن `:80` مفتوح لتحدي ACME.
- [ ] إعادة إصدار الشهادة عند الحاجة (القيم أدناه نموذجية، استبدلها):

```bash
MADAR_DOMAIN=<DOMAIN> MADAR_EMAIL=<EMAIL> MADAR_WEBROOT=/var/www/certbot MADAR_NGINX_CONF=/etc/nginx/conf.d/madar.conf bash deploy/certbot/obtain.sh
sudo nginx -t
sudo systemctl reload nginx
```

- [ ] إن مات الإطار بعد التجديد: أعد تحميل الصفحة؛ إن استمر، تحقق من `sudo systemctl reload nginx` ومن بقاء `WSD_TRUSTED_PROXIES=loopback,uniquelocal` في التراكب الإنتاجي، ثم سجّل دخولًا جديدًا — الكوكي القديم بلا `Secure` لا يُحصَّن بأثر رجعي.

## 5) استكشاف مختصر

المؤشرات فقط؛ التفاصيل الكاملة في [استكشاف الأخطاء](INSTALL.md#استكشاف-الأخطاء):

| العَرَض | أول فحص |
| --- | --- |
| اللوحة تُفتح على `http://<PUBLIC_IPv4>:3000` | التركيب الإنتاجي لم يُطبَّق؛ أعد `docker compose -f docker-compose.yml -f docker-compose.prod-tls.yml up -d --remove-orphans` ثم حارسة الربط |
| iframe ميت أو كوكي بلا `Secure` | `X-Forwarded-Proto: https` في nginx + `WSD_TRUSTED_PROXIES=loopback,uniquelocal` في التراكب؛ سجّل دخولًا جديدًا |
| 429 عشوائية على تسجيل الدخول/الفتح/2FA | وكيل غير موثوق أمام `WSD_TRUSTED_PROXIES`؛ راجع حارسة الربط |
| 413 عند استيراد لقطة مشروع | `client_max_body_size 256m` في إعداد nginx |
| JWT يظهر في سجل nginx | استخدم `$uri` لا `$request_uri` في `log_format`؛ لكن `$uri` يحمي **سجل الوصول فقط** — راجع أيضًا `error.log` الافتراضي عند أخطاء upstream واضبط `error_log ... crit;` مع تقييد الوصول للسجلات، والتفاصيل في [INSTALL.md](INSTALL.md#استكشاف-الأخطاء) |
| تجديد الشهادة فاشل | حالة المؤقت + `journalctl` + `:80` + مجلد ACME |

## روابط

- [INSTALL.md — الأمان في النشر (مصدر الحقيقة)](INSTALL.md#الأمان-في-النشر--security-in-production-deployment)
- [INSTALL.md — استكشاف الأخطاء](INSTALL.md#استكشاف-الأخطاء)
