# Qolgan ishlar (2026-10-10 holati)

> **Bu fayl keyingi sessiyalar uchun asosiy ish ro'yxati.**
>
> **Holat:** branch `feature/rebrand`, hali push qilinmagan. Nima tugagani `PROJECT_LOG.md`da.
>
> **Har bir ish uchun tartib:**
>
> 1. Rejaga qarash.
> 2. Agentga topshirish.
> 3. Ishlab turgan app'da skrinshot bilan tekshirish (`./start.sh --remote-debugging-port=9222`, `logs/design/capture.cjs`).
> 4. Type-check (`logs/ui.log` → `No issues found.`) va unit testlar (`httptoolkit-ui`: `npm run test:unit`, `httptoolkit-server`: `npm run test:unit`).
> 5. Commit.

## Ustuvorlik tartibi

| #   | Ish                                                                                                               | Nega                                                     | Hajm      |
| --- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------- |
| 0   | ~~**Devices paneli (View):** qaysi request qaysi qurilmadan kelgani, Proxyman'dagi kabi~~ **tayyor** (2026-10-12) | Egasi 2–3 telefon ulasa View chalkash bo'ladi            | M         |
| 1   | ~~**Send v2:** fayl, rasm va media yuborish, Form, GraphQL, WebSocket~~ **tayyor** (2026-10-10)                   | API testing'ning asosiy qismi, egasi so'radi             | L         |
| 2   | ~~**Connect a phone** ekrani va barqaror port~~ **tayyor** (2026-10-10)                                           | iPhone va Android'ni ulash hozir chalkash, port siljiydi | M         |
| 3   | **Dizayn 3-bosqich:** menu bar, ⌘K, ⌘,                                                                            | Desktop konventsiyalari                                  | M         |
| 4   | Dizaynni qayta tekshirish (`design-critic`)                                                                       | Qabul mezonlari                                          | S         |
| 5   | **iPhone testi** egasi bilan                                                                                      | Haqiqiy qurilmada tekshiruv                              | S         |
| 6   | **Maxfiylik:** upstream'ga telemetriya yuborilmasligi (asosiy qismi tayyor)                                       | "Hech narsa sizib chiqmaydi" va'dasi                     | S, **P0** |
| 7   | O'z `.app`imizni yig'ish va tarqatish                                                                             | Oxirgi natija                                            | L         |
| 8   | Collections davomi: testlar, runner, Keychain                                                                     | Postman bilan teng bo'lish                               | L         |
| 9   | Postman va Proxyman'dan qolgan feature'lar                                                                        | "Bitta dastur" maqsadi                                   | XL        |

---

## 0. Devices paneli (View): tayyor (2026-10-12)

**Nega:** egasi iPhone'ni Wi-Fi orqali uladi va trafik ko'rindi. Lekin 2–3 qurilma bo'lsa, View'da qaysi request qaysi telefondan kelgani bilinmas edi. Endi Proxyman'dagi kabi har bir qurilma **Devices** panelida alohida turadi.

**Nima qilindi:**

- **Panel** (`httptoolkit-ui/src/components/devices/`): View'ning chap tomonida, yig'iladi va kengligi o'zgaradi; ikkalasi ham saqlanadi. Collections paneli bilan umumiy qismlari `components/common/side-panel.tsx`da.
  - Qatorlar: All devices, This Mac, keyin har bir qurilma: tur ikonkasi, nom, IP, request soni va faollik nuqtasi (oxirgi 60 s).
  - Qurilma ochilsa, uning ilovalari va eng ko'p ishlatgan domenlari chiqadi. Bosilsa, ro'yxat shunga filtrlanadi.
  - Klaviatura: strelkalar, Enter (ochish/yopish), F2 (joyida qayta nomlash). O'ng tugma: Rename, Show only this device, Forget name, Copy IP address.
  - Telefon yo'q bo'lsa: "Connect iPhone" va "Connect Android" tugmalari.
- **Ro'yxat:** bir nechta qurilma bo'lsa va All devices tanlangan bo'lsa, "Device" ustuni chiqadi (ikonka va qisqa nom).
- **Filtr:** panel tanlovi filtr qutisi bilan AND bo'ladi. Matnli filtrlar: `device=iphone` (`ipad`, `ios`, `android`, `mac`, `windows`, `linux`, `this`, `other`), `client-ip=192.168.0.23`, `app=Safari`. Ular taklif beradi, `not()`/`or()` ichida va MCP/CLI'da ham ishlaydi. HAR export ko'rinib turgan request'larni oladi.
- **Status bar:** 2 va undan ko'p qurilma bo'lsa "N devices".
- **Testlar:** `test/unit/model/devices/` va `test/unit/components/devices/`.

**Qurilma qanday aniqlanadi:** client IP bo'yicha (`request.remoteIpAddress`; `::ffff:192.168.0.23` va `192.168.0.23` bitta qurilma). Loopback (127.x, ::1) va Send sahifasidan yuborilgan request'lar **This Mac** bo'ladi. Mac'ning o'z LAN IP'si ataylab alohida qurilma: haqiqiy telefonning IP'si doim boshqa, LAN IP'dan kelgan trafik esa odatda simulator yoki test tool. Turi User-Agent'dan olinadi (`model/interception/phone-setup.ts`dagi aniqlash), Android modeli ham ("Pixel 8"). Nomlar localStorage'da IP bo'yicha saqlanadi.

**Keyinroq:**

- DHCP IP'ni almashtirsa, qurilma yangidek ko'rinadi. MAC manzil bilan bog'lash mumkin (`arp -a`).
- USB (ADB) orqali ulangan Android va iOS Simulator trafigi loopback'dan keladi, shuning uchun This Mac ichida chiqadi (This Mac'ni ochib, ilova bo'yicha ajratsa bo'ladi).
- HAR fayllarda client IP saqlanmaydi, shuning uchun import qilingan request'lar hech qaysi qurilmaga tushmaydi.
- Haqiqiy iPhone bilan tekshirish (5-band).

## 1. Send v2: tayyor (2026-10-10)

Reja va tafsilotlar: [`docs/send-v2-plan.md`](send-v2-plan.md).

**Bajarildi:**

- **Body rejimlari:** Form, Multipart (matn va fayl maydonlari, fayl tanlash va drag & drop, Content-Type avtomatik aniqlanadi) va Binary. Fayllar IndexedDB'da saqlanadi va body Send bosilganda yig'iladi. Server `/client/send` 256 MB gacha qabul qiladi.
- **GraphQL rejimi:** query va variables muharrirlari, schema introspection, autocomplete, hover, validation va docs paneli (`graphql-language-service@5.7.0`).
- **WebSocket client:** ulanishni server ochadi (`/client/ws/*`), shuning uchun proxy va sertifikat sozlamalari ishlaydi. Text, JSON va binary xabarlar, saqlangan xabarlar, xabarlar logi va handshake xatolari bor.
- **Collections:** barcha rejimlar Bruno item'lariga yo'qotishsiz saqlanadi. Fayllar collection'ning `files/` papkasida turadi va Bruno zip'ga kiradi. Postman export'i form, multipart, file va graphql rejimlarini oladi. WebSocket request'lari Postman v2.1 formatiga sig'maydi, shuning uchun export'da tushib qoladi va bu haqda ogohlantirish chiqadi.
- **Qabul mezonlari bajarildi:** httpbin multipart (matn va rasm), countries GraphQL schema'si va autocomplete, `wss://echo.websocket.org` echo, collection'ga saqlash va export.

**Qolgan kichik ishlar:**

- View'dan qayta yuborilgan multipart request raw rejimda ochiladi (to'g'ri yuboriladi, lekin maydonlarga ajratilmaydi).
- WebSocket sessiyalari View'ga yozilmaydi. View'da ushlangan WebSocket'ni Resend qilib bo'lmaydi.
- Hech bir request ishlatmaydigan collection fayllari `files/` papkasidan tozalanmaydi.
- Export redaction'i `code` nomli har qanday kalitni secret deb hisoblaydi: GraphQL'dagi `{"code": "UZ"}` export'da `{{code}}` bo'lib qoladi (`httptoolkit-server/src/collections/redaction.ts`).
- 100 MB chegarasi aslida 100 MiB, fayl hajmi esa o'nlik MB'da ko'rsatiladi.
- **Keyinroq:** Socket.IO, jonli SSE oqimi, gRPC (`bruno/packages/bruno-requests`).

## 2. Connect a phone: tayyor (2026-10-10)

**Bajarildi:**

- **iPhone or iPad** kartasi app ichidagi `/intercept/iphone` ekranini ochadi. Unda:
  - Mac IP'si va port nusxa olish tugmasi bilan;
  - 6 qadam va sertifikat sahifasi uchun QR;
  - jonli "iPhone connected" holati (HTTPS o'tyaptimi, shu ham ko'rinadi);
  - AirDrop uchun `.crt` saqlash va oxirida proxy'ni o'chirish eslatmasi.
- **Android** kartasi `/intercept/android` ekranini ochadi: HTTP Toolkit ilovasi uchun QR, ADB, qo'lda proxy sozlash va Android 7+ dagi HTTPS cheklovining izohi.
- **Barqaror port.** Sababi get-port'ning 15–30 soniyalik port qulfi va dev'dagi `module.hot.accept()` edi: u yangi sessiya ochib, eskisini portni band qilgan holda qoldirardi. Endi reload oldingi portni aniq raqami bilan so'raydi (`model/proxy-port-memory.ts`).

**Qolgan kichik ishlar:**

- Dark mode'da Apple client ikonkasi qora chiziladi va ko'rinmaydi (upstream `ClientIcon`).
- Unload bo'lmasdan yopilgan sahifalarning proxy sessiyalari server qayta ishga tushguncha qoladi. Buni tuzatish uchun server tomonida idle sessiyalarni tozalash kerak.
- Haqiqiy iPhone va Android'da hali tekshirilmagan (5-bo'lim).

## 3. Dizayn 3-bosqich

- [x] **Dock nomi va ikonkasi** (2026-10-10). Dev rejimda Dock "Electron" deb ko'rsatardi. `start.sh` endi dev Electron.app'ni Wirepane nomi va ikonkasi bilan belgilaydi (`scripts/brand-dev-electron.sh`).
- [x] **macOS menu bar ikonkasi** (2026-10-12): `httptoolkit-desktop/src/menu-bar-icon.ts`, menyusi Show Wirepane, New Window va Quit. Ishga tushgan app'da bitta status ikonkasi borligi tekshirildi. Menyuni egasi bosib ko'rishi kerak. Keyinroq menyuga proxy holati va Recording tugmasini qo'shish mumkin.

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

- **Avval:** iPhone'da eski "HTTP Toolkit CA" profili bor. Uni o'chirib, yangi **Wirepane CA**ni o'rnatish kerak:
  1. Settings → General → VPN & Device Management → HTTP Toolkit CA → Remove Profile.
  2. Safari'da `http://wirepane.cert/certificate` → Allow.
  3. VPN & Device Management → Wirepane CA → Install.
  4. Settings → General → About → Certificate Trust Settings → Wirepane CA yoqiladi.
- **Proxy porti:** oxirgi marta 8040 edi. Telefondagi port app'dagi Intercept → iPhone or iPad ekranidagi port bilan bir xil bo'lishi kerak.
- **Devices paneli tayyor bo'lgach:** 2 ta qurilma bilan tekshirish (iPhone va Mac).

- Mac IP `192.168.0.156` (o'zgarishi mumkin). Port status bar'da ko'rinadi.
- Qadamlar app'da: Intercept → iPhone or iPad. Sertifikat `http://wirepane.cert/certificate` da, nomi **Wirepane CA**. Tekshiruv: Safari'da `https://wirepane.cert` "You're being intercepted by Wirepane" deb chiqishi kerak.
- Oxirida egasiga proxy'ni **Off** qilishni eslatish.

## 6. Maxfiylik (P0, release'dan oldin albatta)

- [x] **Server va desktop Sentry'si** (2026-10-10). HTTP Toolkit'ning qattiq yozilgan DSN'lari olib tashlandi: `httptoolkit-server/src/error-tracking.ts` va `httptoolkit-desktop/src/errors.ts`. Endi xatolar faqat `SENTRY_DSN` aniq berilsa yuboriladi.
- [x] **Server o'zini yangilamaydi** (2026-10-10). UI har startda `POST /update` so'raydi. Oldin server `oclif update` bilan HTTP Toolkit'ning GitHub release'laridan rasmiy server'ni yuklardi (`logs/server.log`: "Updating CLI... fetching manifest"). Endi so'rov e'tiborsiz qoldiriladi (`httptoolkit-server/src/index.ts`).
- [ ] **UI.** `src/metrics.ts` (PostHog, `events.httptoolkit.tech`) va `src/errors.ts` (Sentry) faqat build paytida `POSTHOG_KEY` yoki `SENTRY_DSN` berilsa yoqiladi. Bizning build'da berilmaydi. `.app` build skriptida bu ikkalasi bo'sh qolishini tekshirish kerak.
- [ ] **Qolgan tarmoq so'rovlari** (2026-10-10 dagi audit):
  - `app.httptoolkit.tech`: desktop'ning default `APP_URL`i (`httptoolkit-desktop/src/index.ts:35`, `stop-server.ts:48`). `.app`da o'z UI build'imizga almashtirilsin (7-bo'lim, 3-band).
  - `github.com/httptoolkit/httptoolkit-android/releases/latest`: Android interception'da APK yuklash (`fetch-apk.ts`). Bu funksional so'rov.
  - `android.httptoolkit.tech/connect`: Android ilovasi uchun deep link, funksional.
  - `amiusing.httptoolkit.tech`: sertifikat va tekshiruv sahifasi. Unga ham proxy'ning o'zi javob beradi, shuning uchun internetga so'rov ketmaydi. Endi asosiy manzil `wirepane.cert`.
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

**Tarqatish (egasining qarori, 2026-10-12):** imzosiz **`.pkg`** installer, ichida ad-hoc imzolangan arm64 `Wirepane.app`. Apple Developer akkaunti yo'q, egasi ariza beradi. Shuning uchun:

- barcha qoidalar akkauntsiz ishlaydi (CLAUDE.md, "Distribution" bo'limi);
- notarize va Developer ID imzosi akkaunt kelgach qo'shiladi.

Gatekeeper birinchi ochishda to'xtatadi: o'ng tugma → Open yoki "Open Anyway". `curl … | sh` bilan o'rnatilsa ogohlantirish chiqmaydi.

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
