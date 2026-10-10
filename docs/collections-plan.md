# Collections va file orqali ulashish (Bruno asosida)

> **Maqsad (egasining so'zlari bilan):**
>
> 1. Backend dasturchi API yaratadi va uni hujjatlashtiradi.
> 2. Mobile, frontend va Telegram bot dasturchilarga **bitta fayl** qilib yuboradi: Telegram, email, Git, xohlagan yo'l bilan.
> 3. Ular faylni Wirepane'ga import qiladi va hammasi tayyor holatda ochiladi.
>
> Hammasi bepul: cloud yo'q, akkaunt yo'q, secret'lar sizib chiqmaydi.

## Nimani yasaymiz

| Qism                  | Natija                                                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Collections**       | Send sahifasida Collections paneli: collection → folder → request. Har bir request va collection'da Markdown hujjat, saqlangan response example'lari, environment'lar va `{{variable}}`lar bor |
| **Save from traffic** | View'da tanlangan request'lar "Save to collection" bilan collection'ga tushadi, haqiqiy response'lar example bo'lib saqlanadi                                                                  |
| **Share (export)**    | Bitta fayl: **Postman Collection v2.1 JSON**. Uni Postman, Bruno, Insomnia va Hoppscotch ham ochadi. Git uchun Bruno folder (`.bru`) formati ham bor. **Secret'lar faylga tushmaydi**          |
| **Import**            | Faylni Wirepane'ga sudrab tashlash yoki "Import…" bilan ochish. Postman v2.1, Bruno folder yoki zip, Insomnia, OpenAPI, WSDL, HAR qo'llab-quvvatlanadi                                         |

## Nega Bruno package'lari

Bruno (MIT) bu ishning katta qismini allaqachon qilgan. Biz uning logikasini npm'dan olamiz, UI'ni esa o'zimizning stack'da (React, MobX, styled-components) yozamiz. `bruno/` subtree manba sifatida va yangilanishlarni kuzatish uchun turadi.

| Package (npm, MIT)              | Nima uchun                                                                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@usebruno/converters` (0.24)   | `postmanToBruno`, `postmanToBrunoEnvironment`, `insomniaToBruno`, `openApiToBruno`, `wsdlToBruno` va **`brunoToPostman`** (export), shuningdek `postmanTranslation` (`pm.*` → `bru.*`) |
| `@usebruno/lang` (0.40)         | `.bru` fayllarni o'qish va yozish (`bruToJsonV2`, `jsonToBruV2`, environment va collection fayllari)                                                                                   |
| `@usebruno/filestore` (0.13)    | Collection'ni diskda papka sifatida saqlash                                                                                                                                            |
| `@usebruno/schema` (0.30)       | Collection JSON'ni tekshirish (Yup)                                                                                                                                                    |
| `@usebruno/js` (0.54), keyinroq | Script'lar va testlar (`bru.*`, `pm.*`, chai). Node'da, server tomonida ishlaydi                                                                                                       |

Ichki model sifatida **Bruno collection JSON**ini olamiz. Shunda converter'lar to'g'ridan-to'g'ri ishlaydi va Postman va Insomnia'ga ko'prik tayyor bo'ladi.

## Arxitektura

```
UI (httptoolkit-ui, brauzer)                 Server (httptoolkit-server, Node)
──────────────────────────────               ─────────────────────────────────────
src/model/collections/                       src/collections/   (yangi papka)
  collections-store.ts   (MobX)    ── REST ─▶  collections-service.ts
  variables.ts  ({{var}}, env)                  · fayldan o'qish/yozish (@usebruno/lang, filestore)
  send-bridge.ts (Send tab ⇄ request)           · import (@usebruno/converters)
src/components/collections/                     · export Postman v2.1 / Bruno (+ redaction)
  collections-panel.tsx  (Send chap paneli)   src/api/rest-api.ts  (+ bir nechta endpoint)
  docs-tab.tsx, import-dialog.tsx,
  share-dialog.tsx
```

- **Fayllar server orqali.** Diskka faqat server yozadi, chunki UI brauzerda ishlaydi va fayl tizimiga to'g'ridan-to'g'ri kira olmaydi. So'rovlar mavjud `Origin` tekshiruvidan o'tadi.
- **Saqlash joyi.** Default: `~/Library/Application Support/Wirepane/collections/<nom>/` (Bruno folder formati). Foydalanuvchi o'z papkasini ham tanlashi mumkin, masalan Git repo ichidagi papkani.
- **Variables.** Send'ning yuborish pipeline'iga bitta ulanish qo'shiladi: `prepareForSend()` `{{var}}`larni environment'dan almashtiradi. Upstream faylga bitta qator qo'shiladi.
- **Secret'lar.** Secret deb belgilangan environment qiymatlari faqat lokal saqlanadi: macOS'da Keychain, boshqa joyda shifrlangan fayl. Ular **hech qachon export qilinmaydi**: export'da qiymat bo'sh bo'ladi va oluvchi uni o'zi kiritadi.
- **Avtomatik redaction.** Export oldidan `Authorization`, `Cookie`, `X-*-Key` header'lari va `token`/`key`/`secret` query param'lari tekshiriladi. Topilgan qiymat `{{variable}}` bilan almashtiriladi va foydalanuvchiga ko'rsatiladi: "3 ta secret olib tashlandi".

## Bosqichlar

1. **C1 — server.**
   - `src/collections/` servisi: ro'yxat, ochish, saqlash, o'chirish.
   - Import: Postman, Bruno, Insomnia, OpenAPI va HAR.
   - Export: Postman v2.1 va Bruno, redaction bilan.
   - REST endpoint'lar va unit testlar (Mocha, fixture fayllar bilan).
2. **C2 — UI.**
   - Send'da Collections paneli: daraxt, qidiruv, yangi collection, folder va request.
   - Request'ni Send tab'ida ochish va tab'ni collection'ga saqlash.
   - Har bir request va collection uchun Docs tab (Markdown, ko'rish va tahrirlash).
   - Environment tanlagich va `{{var}}`lar.
3. **C3 — trafikdan.** View'da "Save to collection": bitta yoki bir nechta request tanlanadi, host bo'yicha folder'larga ajratiladi va response example bo'lib qoladi.
4. **C4 — share.**
   - "Share…" dialogi: format (Postman v2.1 JSON yoki Bruno zip), redaction hisoboti va faylni saqlash.
   - Import: drag & drop, "Import…" menyusi va macOS'da faylni Wirepane bilan ochish (file association).
5. **C5 — keyinroq.**
   - `@usebruno/js` bilan testlar (`pm.test` va `bru` mos).
   - Collection runner va JUnit/HTML hisobot.
   - CLI va MCP operatsiyalari: `collections.run`, `send.request`.
   - Mock'larni collection example'laridan yaratish.

## Qabul mezonlari

- Postman'dan export qilingan v2.1 collection Wirepane'ga import bo'ladi, request'lari Send'da ochiladi va yuboriladi.
- Wirepane'dan export qilingan fayl Postman'ga va Bruno'ga import bo'ladi. Ular bilan sinab ko'riladi.
- Export faylida hech qanday secret qiymat yo'q. Test token, cookie va API key bilan tekshiriladi.
- View'dan 5 ta request tanlab "Save to collection" qilinsa, ular example'lari bilan collection'da paydo bo'ladi.
- Hammasi oflayn ishlaydi, tarmoq faqat request yuborilganda ishlatiladi.

## Cheklovlar

- **Upstream sync.** Hamma yangi kod yangi papkalarga yoziladi: UI'da `src/model/collections/`, `src/components/collections/`, server'da `src/collections/`. Upstream fayllarga faqat bir necha qatorlik ulanishlar qo'shiladi.
- **Brend.** "Import from Postman" kabi nomlar ishlatiladi. Postman nomi faqat format nomi sifatida tilga olinadi.
- **Litsenziya.** Bruno kodining MIT `license.md` yozuvlari saqlanadi.
