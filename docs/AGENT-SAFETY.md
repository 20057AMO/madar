# Agent safety — Madar (مدار)

> Short operational note on opencode agent permissions and secret exposure. Version: **BETA**.

---

## العربية — صلاحيات الوكلاء

- خط opencode المدعوم في Madar هو 1.x (تم التحقق مع 1.19.6)، لذلك يستخدم `opencode.json` المفتاح `permission` الخاص بـ V1؛ مفتاح `permissions` الخاص بـ V2 لا يُستخدم في هذه النسخة.
- أُضيف إلى `opencode.json` افتراض `edit: ask` و `bash: ask`. القواعد الصريحة المكتوبة داخل ملفات الوكلاء تبقى سارية؛ الافتراض لا يلغيها.
- وكلاء القراءة فقط: `accessibility-auditor`, `api-designer`, `architect`, `code-reviewer`, `madar-expert`, `prompt-engineer`, `security-auditor`, `ux-designer`. جميعهم يعلنون `edit: deny` و `bash: deny`.
- وكلاء shell بدون تعديل: `incident-responder`, `log-analyst`, `pentester`. يعلنون `edit: deny` و `bash: allow`.
- `orchestrator` يعلن `edit: deny` و `bash: deny` لكنه يملك `task: allow`؛ لذلك يصنّفه Madar كوكيل كتابة عند التفويض، وليس `readonly`.
- الوكلاء الـ16 المتبقون يعلنون `edit: allow` و `bash: allow`؛ هم وكلاء تنفيذ وتعديل.
- تفويض الوكلاء من تبويب **Agents** في المشروع يتطلب دور نظام `editor` أو `admin` لكل الأنواع، بما فيها `readonly`. هذا حدّ صلاحية حقيقي؛ الوكيل المُنفَّذ يعمل داخل حاوية التطبيق.
- مُصنّف القدرات fail-closed: الوكيل يُعدّ `readonly` فقط إذا كان `edit: deny` و `bash: deny` ولا يملك `task: allow`؛ أي غياب أو قيمة غير معروفة تُعدّ كتابة.
- مسار CLI الاحتياطي محصور بالوكلاء الكتابة وأصحاب الدور `editor`/`admin`، ولا يُطلق إلا إذا لم يُقبل الأمر من الأساس، ولا يمرّر `--agent` حتى لا يتجاوز منع الصلاحيات المكتوب في frontmatter.

## العربية — الأسرار

- مفاتيح مزوّدي LLM تُدار في إعدادات المزوّدين على الخادم فقط.
- حاويات المشاريع باسم `wsd-<slug>` لا تتلقى مفاتيح مزوّدين تلقائياً؛ تتلقى فقط متغيرات البيئة التي يضيفها المستخدم في إعدادات المشروع، بالإضافة إلى `DEBIAN_FRONTEND=noninteractive`.
- لا تضع مفاتيح حقيقية في متغيرات بيئة المشروع؛ المتغيرات تُمرَّر إلى الحاوية وقد يراها من يستطيع قراءة إعدادات المشروع.

## English — Agent permissions

- Madar supports the opencode 1.x line (validated with 1.19.6), so `opencode.json` uses the V1 `permission` key; the V2 `permissions` array is not used by this install.
- `opencode.json` now sets default `edit: ask` and `bash: ask`. Explicit rules in agent files remain in force; the default does not override them.
- Read-only agents: `accessibility-auditor`, `api-designer`, `architect`, `code-reviewer`, `madar-expert`, `prompt-engineer`, `security-auditor`, `ux-designer`. All declare `edit: deny` and `bash: deny`.
- Shell-only agents: `incident-responder`, `log-analyst`, `pentester`. They declare `edit: deny` and `bash: allow`.
- `orchestrator` declares `edit: deny` and `bash: deny` but has `task: allow`; Madar classifies it as write-capable for delegation, not `readonly`.
- The remaining 16 agents declare `edit: allow` and `bash: allow`; they are implementation agents.
- Delegation from a project's **Agents** tab requires system role `editor` or `admin` for every capability, including `readonly`. This is a real authorization boundary because the delegated agent runs inside the app container.
- Capability classification is fail-closed: an agent is `readonly` only when `edit: deny`, `bash: deny`, and no `task: allow`; missing or unknown values are treated as write-capable.
- The CLI fallback is limited to write-capable agents and system `editor`/`admin` users, fires only when the prompt was never admitted, and never passes `--agent`, so frontmatter permission denies cannot be bypassed.

## English — Secrets

- LLM provider keys are handled server-side in provider configuration only.
- Project containers named `wsd-<slug>` do not receive provider keys automatically; they receive only user-configured project environment entries plus `DEBIAN_FRONTEND=noninteractive`.
- Do not put real keys in project environment variables; those values are passed into the container and may be readable by anyone who can read the project configuration.

## Implementation references

`opencode.json` · `opencode/agents/*.md` · `backend/src/services/opencode-delegate-core.ts` · `backend/src/services/opencode-delegate.ts` · `backend/src/services/docker-manager.ts`
