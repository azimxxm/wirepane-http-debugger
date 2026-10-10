# Postman tadqiqoti: nima u, nima qila oladi va biz nimani olamiz

> **Holat:** 2026-10-10.
>
> **Manbalar:** Postman'ning rasmiy sayti, docs, pricing va changelog'i, Hacker News, GitHub issues, CloudSEK va Truffle Security hisobotlari.
>
> **Qanday qilingan:**
>
> - 3 ta research agenti: mahsulot xaritasi, QA va traffic capture, narxlar va shikoyatlar.
> - Fit: topilganlarni bizning kodga solishtirish.
> - Verify: asosiy faktlarni rasmiy manbalardan tekshirish.
>
> **Xom ma'lumot:** [`postman-data/`](postman-data/). Unda har bir taklif uchun fayl yo'llari va amalga oshirish qadamlari bor.

## Qisqa javob

- **Postman nima:** o'zini "AI-native API Platform" deb ataydi. Ichida API client, collections, testlar va runner, mock serverlar, monitorlar, hujjat, cloud workspace'lar va AI agent bor. 2026-03-01 da v12 chiqdi: endi u Git bilan ishlaydi va collection'larni YAML formatida saqlaydi.
- **Uning feature'larini qo'llay olamizmi?** Ha, lekin hammasini emas. Postman'ni ko'chirmaymiz.
- **Bizning ustunligimiz:** biz **haqiqiy trafikni ko'ramiz va o'zgartiramiz**. Postman'ning proxy va Interceptor'i trafikni faqat yozib oladi: jonli trafikni to'xtata (breakpoint), o'zgartira (rewrite) yoki mock qila olmaydi.
- **Biz yopadigan sikl:** "ko'rdim → saqladim → test yoki mock qildim". Bu bir klikda, akkauntsiz va bepul.
- **Eng muhim 6 ta qadam (P1):**
  1. Ushlangan trafikni collection sifatida saqlash.
  2. `pm.test` bilan mos assertion'lar: yuborilgan so'rovlar uchun ham, jonli trafik uchun ham.
  3. Postman v2.1 collection import va export.
  4. Variables va environments, secret'larni faqat lokal saqlash bilan.
  5. Export'larda secret'larni avtomatik yashirish.
  6. Auth helper'lar.

## Postman nima: mahsulotlar xaritasi

| Mahsulot                                                            | Nima qiladi                                                                                                                    | Plan                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| Desktop app                                                         | Asosiy ilova (macOS arm64/Intel, Windows, Linux). Proxy capture, Browser Tool, Native Git va terminal faqat shu yerda ishlaydi | Free+                     |
| Web app                                                             | Brauzerda ishlaydi, akkaunt shart                                                                                              | Free+                     |
| Lightweight API Client                                              | Akkauntsiz rejim: HTTP, WebSocket, GraphQL, gRPC, MQTT. **Collection va environment yo'q**, hammasi lokal                      | akkauntsiz                |
| Postman CLI                                                         | `postman collection run`, lint, mock, workspace push. Newman o'rnini bosgan                                                    | Free+                     |
| Newman                                                              | Eski runner, endi **qo'llab-quvvatlanmaydi** va v3 collection'larni ishga tushira olmaydi                                      | —                         |
| VS Code extension                                                   | Editor ichida client, akkaunt shart                                                                                            | Free+                     |
| Agent Mode (AI)                                                     | So'rov yozadi, testlar yaratadi, xatolarni tahlil qiladi. Pulli **AI credit** bilan ishlaydi                                   | Free: oyiga 50 credit     |
| MCP Server, coding-agent plugin                                     | AI agentlar Postman'ni boshqaradi                                                                                              | akkaunt                   |
| Capture: proxy, Interceptor, Browser Tool                           | Trafikni yozib collection'ga saqlaydi. **Rewrite, breakpoint va map local yo'q**                                               | —                         |
| Spec Hub                                                            | OpenAPI, AsyncAPI, protobuf, GraphQL tahrirlash va lint                                                                        | Free+                     |
| Mock servers                                                        | Saqlangan example'lardan mock. 2026-03 dan beri cheksiz                                                                        | Free+                     |
| Collection Runner, scripts, tests                                   | `pm.test` va `pm.expect`, iteratsiyalar. Data fayllar faqat pullik planda                                                      | Free+ (qisman)            |
| Performance testing                                                 | Virtual user'lar bilan yuklama testi                                                                                           | lokal bepul, cloud pullik |
| Monitors                                                            | Jadval bo'yicha collection ishga tushirish                                                                                     | Free: oyiga 1 000 so'rov  |
| Flows                                                               | Low-code canvas                                                                                                                | credit bilan              |
| Vault                                                               | Secret'larni lokal saqlash, shared vault pullik                                                                                | Free+                     |
| Native Git                                                          | Collection'lar repo ichida YAML fayl bo'lib turadi                                                                             | Free+                     |
| Workspaces, API Network, Docs, SDK generator, API Catalog, Insights | Cloud hamkorlik va enterprise boshqaruv                                                                                        | asosan pullik             |

## API client imkoniyatlari (qisqacha)

- **Protokollar:** HTTP/REST (HTTP/2 bilan), SSE, GraphQL (introspection bilan), gRPC (streaming bilan), WebSocket va Socket.IO, MQTT, SOAP (oddiy XML POST sifatida), AI/LLM so'rovlari, MCP client, Unix socket.
- **Collections:** folder'lar, saqlangan response example'lari, collection va folder darajasida auth, script va variable'lar.
- **Variables:** global, collection, environment, data va local scope'lar; eng tor scope ustun turadi. Environment almashtirgich va `{{vault:...}}` secret'lar bor.
- **Auth:** API Key, Bearer, JWT, Basic, Digest, OAuth 1/2, AWS SigV4, NTLM, Hawk. Inherit qilish mumkin.
- **Test va script:** pre-request va post-response JavaScript, `pm.test` va `pm.expect` (chai), JSON schema tekshiruvi.
- **Kod generatsiyasi:** 35 ta til va kutubxona.
- **Cookie va sertifikatlar:** har bir domen uchun cookie jar, client sertifikat (CRT+KEY yoki PFX), custom CA.
- **Import:** cURL, OpenAPI, Insomnia, Hoppscotch, Thunder Client va SoapUI'dan migratsiya. HAR import v12 docs'da tilga olinmagan.
- **Export:** collection (v2.1 JSON), environment, run natijalari (JSON).

## Narxlar va Free plan (2026, rasmiy manbalardan tekshirilgan)

| Plan       | Narx                                                       | Foydalanuvchilar                                                    |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| Free       | $0                                                         | **1 kishi, team yaratib bo'lmaydi.** 2026-03 gacha 3 kishigacha edi |
| Solo       | $9/oy (yillik to'lov)                                      | 1                                                                   |
| Team       | $19/kishi/oy (yillik to'lov)                               | cheksiz                                                             |
| Enterprise | "Contact sales". Ochiq $49 narx 2026-09 da olib tashlangan | cheksiz                                                             |

Free planda:

- **Cheksiz:** collection run va mock'lar.
- **Limitli:** oyiga 50 ta AI credit, 1 000 ta monitor so'rovi va 25 ta Flows credit.
- **Umuman yo'q:** shared vault, cloud yuklama testi, monitor hisobotlari, SSO.

## Foydalanuvchilar nimadan norozi

1. **Majburiy akkaunt va cloud.** Scratch Pad 2023-09 da olib tashlangan. Endi collection va environment'lar faqat login bilan ishlaydi. 2025-10-20 da AWS uzilishi paytida Postman lokal ish uchun ham ishlamay qoldi.
2. **Secret'lar oshkor bo'lishi.** 30 000 dan ortiq ochiq workspace orqali token va kalitlar sizib chiqqan (CloudSEK, 2024-12). Postman'ning "secret" va "Initial value" maydonlari foydalanuvchini chalg'itadi.
3. **Free plan qisqardi:** endi faqat 1 kishi. Hamkorlik uchun har bir kishiga $19 to'lash kerak.
4. **Narxlar tez-tez o'zgaradi:** 2024-04 dan beri 11 marta. Enterprise narxi yashirildi.
5. **Og'ir app:** RAM'ni ko'p yeydi (2018 dan beri ochiq issue). 250 MB'lik response app'ni qulatadi, 1 MB'dan katta JSON uni qotiradi.
6. **Haddan tashqari murakkab:** "overcomplicated mess", "overwhelming".
7. **Majburiy AI:** Agent Mode popup'ini yopib bo'lmagan.
8. **Lock-in:** WebSocket va gRPC collection'larini export qilib bo'lmaydi (2022 dan beri ochiq issue). Auto-update'ni o'chirib bo'lmaydi (2019 dan beri ochiq issue).

**Odamlar qayerga o'tyapti:**

- Bruno: fayllar Git'da, offline, akkauntsiz.
- Yaak va Insomnium.
- Hoppscotch.
- Hurl va `.http` fayllar.
- Kreya.

## Bizda allaqachon nima bor

| Bor                                                                                | Kamchilik                                                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Send sahifasi: tab'li HTTP client (method, URL, headers, body)                     | Nom, folder, collection, variable, auth, test yo'q. SSE oxirigacha ko'rinmaydi                    |
| View'dan so'rovni Send'da qayta yuborish                                           | Faqat bittadan. Response example sifatida saqlanmaydi                                             |
| URL'ga cURL paste qilish va HAR'dan so'rov yuklash                                 | Postman collection, OpenAPI yoki `.http` import yo'q                                              |
| "Copy as code snippet" (httpsnippet'dagi barcha tillar)                            | Authorization va Cookie header'lar export'da ochiq qoladi                                         |
| HAR export va import, ZIP export                                                   | Secret'lar yashirilmaydi. Import qilingan trafik collection yoki test bo'la olmaydi               |
| Trafikdan mock yaratish (bitta so'rov yoki tanlangan guruh)                        | Faqat aniq so'rovga mos keladi, ID'larni umumlashtirmaydi                                         |
| Rules engine: mock, map remote, transformer, breakpoint, delay, timeout, WebSocket | Chaos (tasodifiy xato), bandwidth preset'lari va assertion yo'q                                   |
| Rules faylga saqlanadi                                                             | Bitta JSON blob, Git'da diff qilish qiyin                                                         |
| OpenAPI spec bilan trafikni tanish va parametrlarni tekshirish                     | Response'ni spec'ga solishtirmaydi                                                                |
| CLI/MCP bridge                                                                     | Faqat o'qish operatsiyalari bor: so'rov yuborish, testlarni ishga tushirish va mock yaratish yo'q |

## Tavsiyalar

| #   | Feature                                                                                              | Foydasi                                                                                                                                          | Hajm |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| P1  | **Ushlangan trafikni collection sifatida saqlash** (Send'da Collections va History paneli)           | Brauzer, telefon yoki Docker trafigi bir klikda nomlangan, qayta ishlatiladigan so'rovlarga aylanadi, haqiqiy response'lar example bo'lib qoladi | L    |
| P1  | **Assertion'lar** (`pm.test` bilan mos): yuborilgan so'rovlar va **jonli trafik** uchun              | QA bir marta tekshiruv yozadi va istalgan qurilmadan kelgan har bir mos so'rovda pass yoki fail ko'radi. Bunday bepul tool topilmadi             | L    |
| P1  | **Postman v2.1 collection, environment va globals import/export**                                    | Postman foydalanuvchisi bitta drag-and-drop bilan o'tadi                                                                                         | M    |
| P1  | **Variables, environments, lokal secret'lar**, response'dan qiymat olib keyingi so'rovga ulash bilan | Bitta so'rovlar dev, staging va prod'da ishlaydi. Token'lar zanjir bo'lib uzatiladi. Secret'lar kompyuterdan chiqmaydi                           | M    |
| P1  | **Export'da secret'larni yashirish** va lokal secret-leak lens                                       | HAR va ZIP'ni bug ticket'ga xavfsiz biriktirish mumkin. QA token'lar qayerga ketayotganini ko'radi                                               | S    |
| P1  | **Auth helper'lar** inheritance bilan (Bearer, Basic, API key, OAuth2, AWS SigV4, JWT)               | Auth header'larni qo'lda yozish kerak emas. Import qilingan Postman collection'lar ishlayveradi                                                  | M    |
| P2  | Aqlliroq mock'lar: collection'dan, status bo'yicha example tanlash, ID'larni umumlashtirish          | Backend tayyor bo'lmasa ham frontend va mobil ish davom etadi                                                                                    | M    |
| P2  | Ushlangan trafikni OpenAPI kontraktiga solishtirish                                                  | API spec'dan og'ishini oddiy debug paytida ko'rasiz                                                                                              | M    |
| P2  | Collection runner: bepul data fayllar, JUnit va HTML hisobotlar                                      | Data asosidagi regressiya testlari                                                                                                               | L    |
| P2  | CLI va MCP orqali yozish: so'rov yuborish, collection ishga tushirish, mock yaratish                 | AI agentlar va CI akkauntsiz ishlaydi                                                                                                            | S    |
| P2  | `.http`, Hurl va Playwright testlariga export                                                        | Trafik Git'da va CI'da yashaydi, lock-in yo'q                                                                                                    | M    |
| P2  | Send va ushlangan trafik uchun umumiy cookie jar                                                     | Brauzerdagi login sessiyasi Send'da ham ishlaydi                                                                                                 | M    |
| P3  | OpenAPI spec'dan collection yaratish                                                                 | Spec'dan boshlab test qilish                                                                                                                     | M    |
| P3  | Send'da jonli SSE va WebSocket client                                                                | Streaming API'larni (LLM, notification) debug qilish                                                                                             | L    |
| P3  | Chaos va tarmoq sharoiti preset'lari (sekin, uzilgan, 503)                                           | Sekin yoki yo'q API'da app qanday ishlashini tekshirish                                                                                          | M    |

**Qanday qurish kerak:** hamma yangi kod yangi papkalarga tushadi: `src/model/collections/` va `src/model/testing/`. Upstream fayllarga faqat bir qatorlik ulanishlar qo'shiladi, shunda `sync-upstream.sh` conflict'lari kam bo'ladi. Har bir taklifning fayl darajasidagi qadamlari [`postman-data/fit.json`](postman-data/fit.json)da.

## Nimani ko'chirmaymiz

- Akkauntlar, cloud workspace'lar, sync, seat'lar va team planlar.
- Public workspace'lar, API Network, hosted docs.
- Monitorlar, cloud runner'lar, cloud yuklama testlari, Cloud Agent.
- Flows (low-code canvas).
- Credit bilan ishlaydigan Agent Mode va majburiy AI onboarding.
- Spec Hub designer, governance, API Catalog, Insights.
- To'liq `postman-sandbox` package kutubxonasi.
- "Initial value" bilan "Current value"ning alohida bo'lishi (chalkash).
- Collection v3 YAML'ni asosiy format qilish (hozircha).
- Interceptor brauzer extension va o'rnatilgan Browser Tool.
- Hosted webhook URL'lar.
- Telemetriyani sukut bo'yicha yoqib qo'yish va majburiy auto-update.

## Pozitsiya

**Wirepane** — bepul, lokal va akkauntsiz HTTP debugger. U haqiqiy trafikni API ishiga aylantiradi:

- brauzer, telefon, Docker va terminal trafigini ushlaydi;
- trafikni jonli o'zgartiradi, mock qiladi va breakpoint qo'yadi;
- ko'rganingizni Postman bilan mos collection sifatida saqlaydi va tanish `pm.test` assertion'lari bilan tekshiradi;
- HAR, Postman v2.1, `.http`/Hurl yoki Playwright testi sifatida export qiladi, secret'lar sukut bo'yicha yashirilgan holda.

Postman — capture tool qo'shib qo'yilgan API platforma: u jonli trafikni to'xtata yoki o'zgartira olmaydi, bepul plani esa qisqarib boryapti. Proxyman — to'liq client'i va testlari bo'lmagan pullik interceptor. Wirepane avvalo interceptor, ustiga ixcham Postman-mos client va test qatlami qo'shilgan. Seat, cloud va metr yo'q.

## Faktlar tekshiruvi (Verify agenti)

| Da'vo                                                                                      | Natija                                                        |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| 2026-03 dan beri Free plan 1 kishi, team yo'q (oldin 3 kishigacha edi)                     | ✅ tasdiqlandi (aniq kuni tekshirilmagan)                     |
| 2026-03 dan beri collection run va mock'lar barcha planlarda cheksiz                       | ✅ tasdiqlandi                                                |
| Solo $9, Team $19/kishi (yillik to'lov), Enterprise "contact sales"                        | ✅ tasdiqlandi ($49 narx olib tashlangan sana tekshirilmagan) |
| Free: 50 AI credit, 1 000 monitor so'rovi, 25 Flows credit                                 | ✅ tasdiqlandi                                                |
| Scratch Pad v10.18 dan boshlab olib tashlangan; akkauntsiz faqat Lightweight client qoladi | ✅ asosan tasdiqlandi                                         |
| Newman qo'llab-quvvatlanmaydi va v3 collection'larni ishga tushira olmaydi                 | ✅ tasdiqlandi                                                |
| v12 2026-03-01 da chiqdi: Native Git va v3 YAML qo'shildi, Postbot olib tashlandi          | ✅ tasdiqlandi                                                |
| Capture bor, lekin rewrite, breakpoint va map local yo'q                                   | ✅ tasdiqlandi, uchinchi usul ham bor: Browser Tool           |
| Browser Tool 12.15.0 (2026-06-15) da qo'shilgan                                            | ✅ asosan tasdiqlandi                                         |
| CloudSEK: 30 000 dan ortiq workspace'dan secret sizib chiqqan (2024-12)                    | ✅ tasdiqlandi                                                |

## Cheklovlar

- **Research vaqt chegarasi bilan to'xtatildi.** Quyidagilar tekshirilmagan:
  - Proxyman, Charles va Reqable'ni nima uchun yaxshi ko'rishadi;
  - Bruno, Yaak va Insomnia'ning 2026 narxlari;
  - Postman proxy'si HTTP/2 va WebSocket'ni ushlay oladimi.
- **Bloklangan manbalar:**
  - Reddit, G2 va Capterra sahifalari ochilmadi; G2 sharhlari AWS Marketplace orqali olindi.
  - web.archive.org bloklangan.
- **Raqobatchilar materiallari** (Apidog, EchoAPI) faqat misol sifatida olindi, chunki ular xolis emas.
- **Litsenziyalar.** Postman'ning open-source kutubxonalari (code generators, collection schema) AGPL ilovada ishlatishdan oldin litsenziya bo'yicha tekshirilishi kerak.

## Asosiy manbalar

- Narxlar: https://www.postman.com/pricing/
- Planlar: https://learning.postman.com/docs/billing/about-plans
- v12 e'loni: https://blog.postman.com/new-capabilities-march-2026/
- Changelog: https://www.postman.com/release-notes/postman-app/
- Scratch Pad'ning olib tashlanishi: https://blog.postman.com/announcing-new-lightweight-postman-api-client/
- Proxy capture: https://learning.postman.com/docs/use/capturing-request-data/capture-with-proxy/
- Newman'dan Postman CLI'ga o'tish: https://learning.postman.com/docs/reference/newman-cli/migrate-to-postman-cli/
- CloudSEK hisoboti: https://cloudsek.com/blog/postman-data-leaks-the-hidden-risks-lurking-in-your-workspaces
- Truffle Security: https://trufflesecurity.com/blog/postman-carries-lots-of-secrets
- HN, AWS uzilishi: https://news.ycombinator.com/item?id=45645172
- HN, majburiy akkaunt: https://news.ycombinator.com/item?id=37792690
- HN, Bruno: https://news.ycombinator.com/item?id=39653718
- RAM issue: https://github.com/postmanlabs/postman-app-support/issues/4687
- Export lock-in issue: https://github.com/postmanlabs/postman-app-support/issues/11252
