# Qolgan ishlar (2026-10-10 holati)

> **Bu fayl keyingi sessiyalar uchun asosiy ish ro'yxati.**
>
> **Holat:** branch `feature/rebrand`, 28 commit, hali push qilinmagan. Nima tugagani `PROJECT_LOG.md`da.
>
> **Har bir ish uchun tartib:**
>
> 1. Rejaga qarash.
> 2. Agentga topshirish.
> 3. Ishlab turgan app'da skrinshot bilan tekshirish (`./start.sh --remote-debugging-port=9222`, `logs/design/capture.cjs`).
> 4. Type-check (`logs/ui.log` → `No issues found.`) va unit testlar (`httptoolkit-ui`: `npm run test:unit`, `httptoolkit-server`: `npm run test:unit`).
> 5. Commit.

## Ustuvorlik tartibi

| #   | Ish                                                                 | Nega                                                     | Hajm      |
| --- | ------------------------------------------------------------------- | -------------------------------------------------------- | --------- |
| 1   | **Send v2:** fayl, rasm va media yuborish, Form, GraphQL, WebSocket | API testing'ning asosiy qismi, egasi so'radi             | L         |
| 2   | **Connect a phone** ekrani va barqaror port                         | iPhone va Android'ni ulash hozir chalkash, port siljiydi | M         |
| 3   | **Dizayn 3-bosqich:** menu bar, ⌘K, ⌘,                              | Desktop konventsiyalari                                  | M         |
| 4   | Dizaynni qayta tekshirish (`design-critic`)                         | Qabul mezonlari                                          | S         |
| 5   | **iPhone testi** egasi bilan                                        | Haqiqiy qurilmada tekshiruv                              | S         |
| 6   | **Maxfiylik:** upstream'ga telemetriya yuborilmasligi               | "Hech narsa sizib chiqmaydi" va'dasi                     | S, **P0** |
| 7   | O'z `.app`imizni yig'ish va tarqatish                               | Oxirgi natija                                            | L         |
| 8   | Collections davomi: testlar, runner, Keychain                       | Postman bilan teng bo'lish                               | L         |
| 9   | Postman va Proxyman'dan qolgan feature'lar                          | "Bitta dastur" maqsadi                                   | XL        |

---

## 1. Send v2

**Hozir:** Send body faqat matn turlarini qabul qiladi: Text, JSON, XML, HTML, CSS, JS (`httptoolkit-ui/src/model/events/content-types.ts`, `EditableContentTypes`). View esa ushlangan WebSocket, GraphQL, multipart va rasmlarni allaqachon ko'rsatadi.

**Qilish kerak:**

- **Body rejimlari.**
  - **Form** (`application/x-www-form-urlencoded`): kalit va qiymat jadvali.
  - **Multipart** (`multipart/form-data`): matn maydonlari va fayl maydonlari (rasm, video, istalgan fayl). Fayl tanlash va drag & drop bo'lsin. Har bir fayl uchun Content-Type avtomatik aniqlansin.
  - **Binary:** bitta faylning o'zi body bo'ladi.
  - Request server orqali yuboriladi, shuning uchun fayl baytlari server'ga to'g'ri yetib borishi kerak (base64 yoki stream). Avval tekshiring: `send-store.ts` → server `send` API.
- **Collections bilan bog'lash.** Bruno modelida `multipartForm`, `formUrlEncoded` va `file` body rejimlari bor (`bruno/packages/bruno-schema`). Mapping: `src/model/collections/request-mapping.ts`. Postman v2.1'ga export: `formdata` (`type: file`) va `urlencoded`. Fayl yo'llari share faylga tushganda ular oluvchida mavjud bo'lmaydi. Share dialogida shu haqda ogohlantirish chiqsin.
- **GraphQL rejimi.**
  - Query muharriri (Monaco va `monaco-graphql`, MIT) va Variables (JSON).
  - Schema introspection tugmasi, shu schema bo'yicha autocomplete va hujjat paneli. Bruno'da `bruno-graphql-docs` package'i bor.
  - Collection'ga GraphQL request sifatida saqlansin. Bruno'da `graphql` turi bor.
- **WebSocket client.**
  - URL, header'lar va subprotocol bilan ulanish.
  - Text, JSON va binary xabar yuborish.
  - Kelgan va ketgan xabarlar logi (vaqt va hajm bilan), ulanishni uzish.
  - Saqlangan xabarlar collection'da tursin.
  - Ulanish server tomonida bo'lishi kerak (yangi endpoint), shunda proxy va sertifikat sozlamalari ishlaydi.
- **Keyinroq:** Socket.IO, jonli SSE oqimi (hozir SSE oxirigacha ko'rinmaydi), gRPC (`bruno/packages/bruno-requests` da tayyor kod bor).

**Qabul mezonlari:**

- `httpbin.org/post`ga rasm va matn maydonli multipart yuborilganda javobda fayl ko'rinadi.
- `https://countries.trevorblades.com` schema'si yuklanadi va query yozganda autocomplete ishlaydi.
- `wss://echo.websocket.org` ga yuborilgan xabar qaytib keladi.
- Uchala tur ham collection'ga saqlanadi va Postman'ga export qilinadi.

## 2. Connect a phone

**Hozir:**

- "iPhone or iPad" kartasi HTTP Toolkit'ning `httptoolkit.com/docs/guides/ios` sahifasini ochadi, app ichida hech narsa ko'rsatmaydi.
- Android uchun "Android (QR code)" bor. U HTTP Toolkit'ning Android ilovasini ishlatadi.
- **Port muammosi:** UI har safar qayta yuklanganda yangi proxy sessiya ochiladi va port suriladi (8000 → 8004 → 8000 → 8001 → 8002). Eski sessiyalar portni bir muddat band qilib turadi. Bu dev rejimda HMR tufayli kuchli seziladi, lekin oyna qayta yuklanganda production'da ham bo'lishi mumkin.

**Qilish kerak:**

- **App ichida "Connect iPhone or iPad" ekrani:**
  - Mac'ning Wi-Fi IP'si va proxy port katta, nusxa olinadigan qilib ko'rsatilsin (IP'ni server beradi: `os.networkInterfaces()`).
  - Sertifikat havolasi `http://amiusing.httptoolkit.tech/certificate` uchun QR kod. QR **proxy sozlangandan keyin** skanerlanishi kerak, shu ham yozilsin.
  - Qadamlar: Wi-Fi → Configure Proxy → Manual → profil o'rnatish → **Certificate Trust Settings**da "HTTP Toolkit CA"ni yoqish → tekshiruv sahifasi.
  - Jonli holat: "Waiting for iPhone…" va iOS User-Agent'li birinchi request kelganda "✓ iPhone connected".
  - Muqobil yo'l: CA faylini `.crt` qilib saqlash (AirDrop uchun).
  - Ish tugagach proxy'ni o'chirish eslatmasi.
- **Barqaror port.** Telefon sozlamasi o'zgarmasligi uchun proxy oldingi portni qayta ishlatsin: eski sessiya yopilganda port bo'shatilsin, yoki Settings'da "fixed port" bo'lsin. Upstream koddagi minimal o'zgarish bilan qiling.
- **Android uchun shunga o'xshash ekran:** QR va ADB. HTTPS cheklovi ham tushuntirilsin: Android 7+ ilovalari foydalanuvchi o'rnatgan CA'ga ishonmaydi, faqat debug build va `network_security_config` bilan ishlaydi.

## 3. Dizayn 3-bosqich

Tafsilotlar `docs/design-plan.md` (Phase 3) va `docs/design/critique-2026-10-10.md` (P1-2, P1-6, P2-4, P2-5, P2-7, P2-8, P2-9, P2-10) da.

- **Menu bar** (`httptoolkit-desktop/src/menu.ts`):
  - App menyusida "Settings… ⌘,".
  - **Go** menyusi: Intercept ⌘1, View ⌘2, Modify ⌘3, Send ⌘4, Command Palette ⌘K.
  - **Capture** menyusi: Pause ⌘⇧R, Clear, Copy proxy address, Import HAR ⌘O, Export HAR.
  - Help menyusidagi "Share Your Feedback" `azimxxm/wirepane` ga borsin.
- **⌘K command palette.** Mavjud modal asosida, sahifalar va asosiy buyruqlar bilan. Monaco ichida ⌘K'ni ushlamasin.
- **Shortcut'lar:** right-click menyulariga accelerator'lar qo'shilsin. Send'dagi Cmd+Tab ⌘⇧] / ⌘⇧[ ga almashtirilsin.
- **Ro'yxat:** toolbar'larda bitta ikonka to'plami (Phosphor). Request ro'yxatida rangli chiziq o'rniga "Type" ustuni va faqat kerak bo'lganda marker; ixtiyoriy Time, Duration va Size ustunlari.
- **Settings:** bo'limli layout, tepada proxy holati, "Appearance".
- **Oyna:** fon rangi temaga mos, `hiddenInset` title bar.
- **Mayda ishlar:**
  - HAR fayl nomi `Wirepane_*.har`;
  - host pill'dagi bo'shliqlar olib tashlansin (`jsonplaceholder . typicode . com` ko'rinishida chiqyapti);
  - View ochilganda ro'yxat atrofida keraksiz focus ring chiqmasin.
- **Faqat dev rejimda:** macOS menu bar'da "Electron" yozuvi. Yig'ilgan `.app`da "Wirepane" bo'ladi.

## 4. Dizaynni qayta tekshirish

`node logs/design/capture.cjs logs/design/after-phase3`, keyin `design-critic`. Qabul mezonlari `docs/design-plan.md`da:

- eski to'q sariq yoki indigo rang qolmagan;
- kontrast AA darajasida;
- har sahifada status bar bor;
- sarlavhalar menyudagi nomlar bilan bir xil;
- bo'sh holatlarda keyingi qadam bor;
- hamma narsa klaviatura bilan bajariladi.

## 5. iPhone testi (egasi bilan)

- Mac IP `192.168.0.156` (o'zgarishi mumkin). Port status bar'da ko'rinadi.
- Qadamlar 2-bo'limda. Tekshiruv: Safari'da `https://amiusing.httptoolkit.tech` sahifasi "You're being intercepted by Wirepane" deb chiqishi kerak.
- Oxirida egasiga proxy'ni **Off** qilishni eslatish.

## 6. Maxfiylik (P0, release'dan oldin albatta)

- [x] **Server va desktop Sentry'si** (2026-10-10). HTTP Toolkit'ning qattiq yozilgan DSN'lari olib tashlandi: `httptoolkit-server/src/error-tracking.ts` va `httptoolkit-desktop/src/errors.ts`. Endi xatolar faqat `SENTRY_DSN` aniq berilsa yuboriladi.
- [x] **Server o'zini yangilamaydi** (2026-10-10). UI har startda `POST /update` so'raydi. Oldin server `oclif update` bilan HTTP Toolkit'ning GitHub release'laridan rasmiy server'ni yuklardi (`logs/server.log`: "Updating CLI... fetching manifest"). Endi so'rov e'tiborsiz qoldiriladi (`httptoolkit-server/src/index.ts`).
- [ ] **UI.** `src/metrics.ts` (PostHog, `events.httptoolkit.tech`) va `src/errors.ts` (Sentry) faqat build paytida `POSTHOG_KEY` yoki `SENTRY_DSN` berilsa yoqiladi. Bizning build'da berilmaydi. `.app` build skriptida bu ikkalasi bo'sh qolishini tekshirish kerak.
- [ ] **Qolgan tarmoq so'rovlari** (2026-10-10 dagi audit):
  - `app.httptoolkit.tech`: desktop'ning default `APP_URL`i (`httptoolkit-desktop/src/index.ts:35`, `stop-server.ts:48`). `.app`da o'z UI build'imizga almashtirilsin (7-bo'lim, 3-band).
  - `github.com/httptoolkit/httptoolkit-android/releases/latest`: Android interception'da APK yuklash (`fetch-apk.ts`). Bu funksional so'rov.
  - `android.httptoolkit.tech/connect`: Android ilovasi uchun deep link, funksional.
  - `amiusing.httptoolkit.tech`: telefonga sertifikat o'rnatish sahifasi, funksional.
  - `httptoolkit.com/pricing`: faqat MCP/CLI matnlarida qolgan, hech qachon ko'rinmaydi.

## 7. O'z `.app`imiz

README'dagi "O'zimizning `.app`imizni yig'ish" bo'limi:

1. `httptoolkit-server/src/constants.ts`: o'z UI origin'imiz uchun ruxsat.
2. Auto-update'ni o'chirish.
   - Server tomoni tayyor: `update-requested` e'tiborsiz qoldiriladi.
   - Qoldi: `package.json`dagi `oclif.update`.
   - **Muhim.** oclif'ning bin skripti `~/.local/share/httptoolkit-server/client/` ichidagi eng yangi server versiyasini ishga tushiradi (`httptoolkit-desktop/src/index.ts`, `cleanupOldServers`). Bu papka rasmiy HTTP Toolkit app bilan umumiy. Ya'ni Mac'da rasmiy app ham o'rnatilgan bo'lsa, Wirepane.app ularning yangilangan server'ini ishga tushirib yuborishi mumkin. Wirepane'ga o'z papkasini bering (`OCLIF_CLIENT_HOME` yoki oclif `dirname`).
3. UI build'ini app ichiga qo'shish va `APP_URL`.
4. `build-setup/setup-server.ts` server'ni GitHub release'dan emas, `../httptoolkit-server` dan yig'sin.
5. `package.json`dagi `extraMetadata.author` va `maintainer` o'z ma'lumotlarimizga almashtirilsin.

**Tarqatish:** Apple Developer sertifikatisiz, ad-hoc imzolangan arm64 `.app`. Brauzerdan yuklangan imzosiz `.app` yoki `.pkg`ni Gatekeeper to'xtatadi ("Open Anyway"). `curl … | sh` bilan o'rnatilsa ogohlantirish chiqmaydi.

## 8. Collections davomi

- **Hali qo'lda tekshirilmagan:**
  - native right-click va "More ▾" menyusidagi "Save to collection…";
  - "⋯" menyusidagi New Request, New Folder va Duplicate;
  - 64 KB dan katta example haqidagi ogohlantirish.
- **Secret saqlash.** Secret qiymatlar hozir oddiy faylda turibdi: `<configPath>/collection-secrets/<id>.json`, faqat shu foydalanuvchi o'qiy oladi. Ularni macOS Keychain'ga o'tkazish kerak.
- **Saqlash joyi.** Collection'ni foydalanuvchi tanlagan papkaga, masalan Git repo ichiga saqlash. Buning uchun saqlash folder'ni to'liq qayta yozmasligi kerak.
- **Formatlar va tezlik.** `.yml` (OpenCollection) collection'larni saqlash; server'da in-memory cache.
- **Postman bilan tenglik (C5):**
  - `pm.test` bilan mos assertion'lar: yuborilgan so'rovlar uchun ham, jonli trafik uchun ham (`@usebruno/js`);
  - collection runner va JUnit/HTML hisobot;
  - CLI va MCP orqali `send.request`, `collections.run`, `rules.mock-from-exchange`;
  - collection example'laridan mock.
- Test ma'lumotlari: `~/Library/Preferences/httptoolkit/collections`dagi 3 ta collection egasi ishlatishi uchun qoldirilgan.

## 9. "Bitta dastur" uchun qolgan feature'lar

Postman'dan (`docs/research/postman.md`):

- auth helper'lar inheritance bilan;
- umumiy cookie jar;
- OpenAPI kontrakt tekshiruvi;
- `.http`, Hurl va Playwright export;
- aqlliroq mock'lar;
- chaos va tarmoq preset'lari;
- OpenAPI'dan collection.

Proxyman'dan (README):

- Access Control;
- macOS system proxy toggle;
- iOS Simulator auto-setup;
- Highlight va Comment;
- Diff;
- Network Conditions;
- DNS Spoofing;
- Scripting;
- Reverse Proxy.

Yashirilgan interceptor'lar: `fresh-safari`, `ios-device`, `network-device`, `virtualbox-machine`, `system-proxy`, `existing-arc`. Ularning server tomoni yo'q. Kerak bo'lsa o'zimiz yozamiz, masalan `ios-device` aynan Connect a phone ekrani bo'ladi.

## 10. Kichik ishlar

- **Brend:** `wirepane.com`, `.dev`, `.app` domenlarini olish va trademark tekshiruvi (USPTO, WIPO).
- **Git:** egasi so'rasa `feature/rebrand`ni push qilish yoki `main`ga merge qilish.
- **Upstream sync:** `./sync-upstream.sh` dan keyin `./setup.sh` (u Bruno'ni ham qayta build qiladi). `// wirepane:` izohli joylarda conflict bo'lishi mumkin.
