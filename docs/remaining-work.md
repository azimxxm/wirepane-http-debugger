# Qolgan ishlar (2026-10-12 holati)

> **Bu fayl keyingi sessiyalar uchun asosiy ish ro'yxati.** Qisqa holat va navbatdagi ishlar: [`docs/next-steps.md`](next-steps.md).
>
> **Holat:** `feature/rebrand` `main`ga merge qilingan va push qilingan (2026-10-12). Release **v1.1.0** chiqdi (2026-10-13, macOS arm64 `.pkg`; o'sha kuni Intel x64 `.pkg` ham qo'shildi). Windows va Linux egasi aytguncha "tez orada" bo'lib turadi.
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
| 3   | ~~**Dizayn 3-bosqich:** menu bar, ⌘K, ⌘,~~ **tayyor** (2026-10-12)                                                | Desktop konventsiyalari                                  | M         |
| 4   | ~~Dizaynni qayta tekshirish (`design-critic`)~~ **bajarildi** (2026-10-12)                                        | Qabul mezonlari                                          | S         |
| 5   | **iPhone testi** egasi bilan                                                                                      | Haqiqiy qurilmada tekshiruv                              | S         |
| 6   | **Maxfiylik:** upstream'ga telemetriya yuborilmasligi (asosiy qismi tayyor)                                       | "Hech narsa sizib chiqmaydi" va'dasi                     | S, **P0** |
| 7   | ~~O'z `.app`imizni yig'ish~~ **yig'ildi**: macOS, Windows, Linux (2026-10-12). CI va o'rnatishni egasi tekshiradi | Oxirgi natija                                            | L         |
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

## 3. Dizayn 3-bosqich: tayyor (2026-10-12)

- [x] **Dock nomi va ikonkasi** (2026-10-10). Dev rejimda Dock "Electron" deb ko'rsatardi. `start.sh` endi dev Electron.app'ni Wirepane nomi va ikonkasi bilan belgilaydi (`scripts/brand-dev-electron.sh`).
- [x] **macOS menu bar ikonkasi** (2026-10-12): `httptoolkit-desktop/src/menu-bar-icon.ts`. Menyusi: Show Wirepane, New Window, Quit.
- [x] **Buyruqlar** (`7105308`):
  - bitta app-actions ro'yxati (`httptoolkit-ui/src/model/ui/app-actions.ts`), undan ⌘K paneli (`components/command-palette.tsx`);
  - macOS menyulari: App → Settings… ⌘,; **Go** (⌘1–⌘4, ⌘K); **Capture** (Pause ⌘⇧R, Clear ⌘⇧⌫, Copy proxy address, Import HAR ⌘O, Export HAR); Help → Report an issue (`azimxxm/wirepane-http-debugger`).
  - Menyu bosilganda buyruq UI'ga IPC orqali boradi (`wirepane:app-action`, `desktopApi.onAppAction`).
  - Send tab'lari ⌘⇧] / ⌘⇧[ bilan almashadi. Context menyularda accelerator'lar ko'rinadi.
- [x] **Ko'rinish** (`7105308`):
  - request ro'yxatida **Type** ustuni, ixtiyoriy Time / Duration / Size ustunlari (header'da right-click), marker faqat breakpoint, xato va rule uchun;
  - Settings bo'limlarga ajratildi: Status, Appearance, Proxy, Connection, API, AI;
  - toolbar'larda Phosphor ikonkalari;
  - macOS'da `hiddenInset` title bar va temaga mos oyna foni;
  - `Wirepane_<sana>.har` nomlari va host pill.
- [x] **Xatolar:** dark mode'dagi qora Apple ikonkasi; export'da `code` kalitining secret deb yashirilishi (`8069552`).

**Qolgan kichik ishlar:**

- Egasi ko'rinadigan oynada bir marta tekshirishi kerak: traffic light'lar 52 px toolbar'ning o'rtasida turibdimi (`trafficLightPosition` {18, 19}), toolbar'ning bo'sh joyini ikki marta bosish oynani kattalashtiradimi; menu bar ikonkasining menyusi.
- "Compact rows" zichlik sozlamasi.
- Modify editor'laridagi to'liq teal kvadrat tugmalar (faqat ikonkalari almashgan).
- Native menyudagi "Pause/Resume Recording" yorlig'i holatga qarab o'zgarmaydi (buning uchun UI → desktop IPC kerak).

## 4. Dizaynni qayta tekshirish: bajarildi (2026-10-12)

Hisobot: [`docs/design/critique-2026-10-12.md`](design/critique-2026-10-12.md). Baho **D → B+**, P0 qolmadi. Rasmlar headless Chrome'da olingan (`logs/design/after-phase3/`).

**Tuzatildi:**

- `5b22903`:
  - View'dagi "Mock response ⌘M" / "Resend ⌘R" yorliqlari, ⌘K'da tanlangan request uchun buyruqlar;
  - Host ustuni kengroq, bitta qurilma bo'lsa Devices paneli yig'iq;
  - filtr, qidiruv va URL maydonlari 3:1 / 4.5:1 kontrastda;
  - status bar'da "⌘K Commands", bitta status pill uslubi, eski ranglar olib tashlandi;
  - focus ring qatorlar ustida;
  - "curl" va "iOS" yozilishi, HAR import/export'da `alert()` yo'q.
- `b3d8945`:
  - Send'da Params · Headers · Body · Docs tab'lari;
  - Params URL bilan sinxron, disabled param'lar va `:path` param'lar;
  - Docs har bir HTTP tab'da, saqlanmagan tab'da ham.

**Qolgan kichik ishlar (v1'dan keyin):**

- Modify'dagi rule qatorlarida method'lar eski palitrada (`rule-row.tsx`, `getMethodColor`). "Existing Terminal" ikonkasi pushti.
- Modify'dagi soya-kartalar (P2-8) va to'liq teal kvadrat tugmalar; key/value jadvallaridagi o'chirish tugmalari to'q teal (bitta accent tugma qoidasiga zid, hammasida birga o'zgartirish kerak).
- 1100 px kenglikda Devices paneli ochiq bo'lsa, ro'yxat sarlavhasi qatorlardan siljiydi.
- Send'dagi collection nomlari kesiladi, panelda bo'sh joy qoladi.
- WebSocket uchun "Headers · Message" tab'lari. ⌘⌥1–4 tab shortcut'lari ⌘K'da yo'q.
- Intercept kartalarida harakat matni ("Open Chrome →"), Settings preview'dagi Monaco ranglari (P2-1, P2-10).
- Qayta tekshirish uchun 1366×768 va bo'sh holatlar ham suratga olinsin.

## 5. iPhone testi (egasi bilan)

- **Bug (egasi, 2026-10-12), release'dan oldin:** iPhone 13 Pro Max Wi-Fi proxy orqali yaxshi ulandi, lekin ba'zi ilovalarning so'rovlari View'da ko'rinmadi. Egasidan qaysi ilovalar ekani va View'da ular uchun "Certificate rejected for …" / "Aborted connection to …" qatorlari chiqqan-chiqmagani so'raldi. Ehtimoliy sabablar:
  - ilova sertifikatni pinning qiladi (bank, Instagram/Facebook/WhatsApp, Apple servislari): View'da shu kulrang qatorlar chiqadi;
  - ilova iOS proxy sozlamasiga amal qilmaydi (Flutter, Unity/Unreal o'yinlari, Telegram'ning MTProto'si, WebRTC, QUIC/UDP): View'da hech narsa chiqmaydi, buni faqat VPN rejimi ko'radi (8.5-bo'lim);
  - ilova proxy yoqilishidan oldin ochilgan va eski ulanishlaridan foydalanyapti: ilovani to'liq yopib, qayta ochish kerak.

- **Avval:** iPhone'da eski "HTTP Toolkit CA" profili bor. Uni o'chirib, yangi **Wirepane CA**ni o'rnatish kerak:
  1. Settings → General → VPN & Device Management → HTTP Toolkit CA → Remove Profile.
  2. Safari'da `http://wirepane.cert/certificate` → Allow.
  3. VPN & Device Management → Wirepane CA → Install.
  4. Settings → General → About → Certificate Trust Settings → Wirepane CA yoqiladi.
- **Proxy porti:** 2026-10-12 dan beri 9473 (9473–9999 oralig'idan, oldin 8000/8040 edi). Telefondagi port app'dagi Intercept → iPhone or iPad ekranidagi port bilan bir xil bo'lishi kerak.
- **Devices paneli tayyor bo'lgach:** 2 ta qurilma bilan tekshirish (iPhone va Mac).

- Mac IP `192.168.0.156` (o'zgarishi mumkin). Port status bar'da ko'rinadi.
- Qadamlar app'da: Intercept → iPhone or iPad. Sertifikat `http://wirepane.cert/certificate` da, nomi **Wirepane CA**. Tekshiruv: Safari'da `https://wirepane.cert` "You're being intercepted by Wirepane" deb chiqishi kerak.
- Oxirida egasiga proxy'ni **Off** qilishni eslatish.

## 6. Maxfiylik (P0, release'dan oldin albatta)

- [x] **Server va desktop Sentry'si** (2026-10-10). HTTP Toolkit'ning qattiq yozilgan DSN'lari olib tashlandi: `httptoolkit-server/src/error-tracking.ts` va `httptoolkit-desktop/src/errors.ts`. Endi xatolar faqat `SENTRY_DSN` aniq berilsa yuboriladi.
- [x] **Server o'zini yangilamaydi** (2026-10-10). UI har startda `POST /update` so'raydi. Oldin server `oclif update` bilan HTTP Toolkit'ning GitHub release'laridan rasmiy server'ni yuklardi (`logs/server.log`: "Updating CLI... fetching manifest"). Endi so'rov e'tiborsiz qoldiriladi (`httptoolkit-server/src/index.ts`).
- [x] **UI** (2026-10-12). `src/metrics.ts` (PostHog, `events.httptoolkit.tech`) va `src/errors.ts` (Sentry) faqat build paytida `POSTHOG_KEY` yoki `SENTRY_DSN` berilsa yoqiladi. `scripts/build-pkg.sh` ularni (`SENTRY_AUTH_TOKEN`, `REPORT_URI` bilan birga) build oldidan o'chiradi, shuning uchun `.app`ga tushmaydi.
- [ ] **Qolgan tarmoq so'rovlari** (2026-10-10 dagi audit):
  - ~~`app.httptoolkit.tech`~~ tayyor (2026-10-12): desktop'ning default `APP_URL`i endi app ichidagi UI (`wirepane://app`), `stop-server.ts` ham shu origin'ni yuboradi.
  - `fonts.cdnfonts.com`: proxy'ning `wirepane.cert` sahifasi (`httptoolkit-ui/src/amiusing.html`) DM Sans shriftini shu CDN'dan yuklaydi. Sahifani ochgan telefon yoki brauzer u yerga so'rov yuboradi.
  - `github.com/httptoolkit/httptoolkit-android/releases/latest`: Android interception'da APK yuklash (`fetch-apk.ts`). Bu funksional so'rov.
  - `android.httptoolkit.tech/connect`: Android ilovasi uchun deep link, funksional.
  - `amiusing.httptoolkit.tech`: sertifikat va tekshiruv sahifasi. Unga ham proxy'ning o'zi javob beradi, shuning uchun internetga so'rov ketmaydi. Endi asosiy manzil `wirepane.cert`.
  - `httptoolkit.com/pricing`: faqat MCP/CLI matnlarida qolgan, hech qachon ko'rinmaydi.

## 7. O'z installer'larimiz: macOS, Windows va Linux (2026-10-12)

Versiya — repo ildizidagi `VERSION` fayli: **1.0.0**. App va server'ning ichki versiyasi `1.27.2` bo'lib qoladi, chunki UI feature'larni shu versiyaga qarab yoqadi. Shuning uchun Finder, Windows'dagi ilovalar ro'yxati va `apt` hali `1.27.2` ko'rsatadi. `1.0.0` esa fayl nomlarida, release tag'ida, macOS'dagi About oynasida ("1.0.0 (based on HTTP Toolkit 1.27.2)") va Settings → Status'da ko'rinadi.

| Tizim                | Buyruq (o'sha tizimning o'zida)                                                            | Fayllar (`httptoolkit-desktop/dist/`)                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| macOS, Apple Silicon | `./scripts/build-release.sh mac` (yoki `./scripts/build-pkg.sh`)                           | `Wirepane-1.0.0-mac-arm64.pkg`, `Wirepane-1.0.0-mac-arm64.zip`                                              |
| macOS, Intel         | `./scripts/build-release.sh mac-x64` (Intel Mac'da, yoki Rosetta 2 bilan Apple Silicon'da) | `Wirepane-1.0.0-mac-x64.pkg`, `Wirepane-1.0.0-mac-x64.zip`                                                  |
| Windows x64          | `./scripts/build-release.sh win` (Git Bash'da)                                             | `Wirepane-1.0.0-win-x64-setup.exe`, `Wirepane-1.0.0-win-x64.zip`                                            |
| Linux x64            | `./scripts/build-release.sh linux` (`rpmbuild` kerak)                                      | `Wirepane-1.0.0-linux-x86_64.AppImage`, `Wirepane-1.0.0-linux-amd64.deb`, `Wirepane-1.0.0-linux-x86_64.rpm` |

GitHub'da `.github/workflows/release.yml` uchala tizimda yig'adi va draft release `v1.0.0` yaratadi: 9 ta fayl (2026-10-13 dan Intel Mac bilan; oldin 7 ta), `SHA256SUMS.txt` va `.github/release-notes.md`dagi matn. Hammasi imzosiz, `GITHUB_TOKEN`dan boshqa secret kerak emas.

macOS natijasi (2026-10-12): `.pkg` 197 MiB (oldin 210), `.zip` 199 MiB, o'rnatilgan app 525 MB (oldin 911 MB).

README'dagi 5 band:

1. [x] Release server faqat `wirepane://app` origin'ga ruxsat beradi (`httptoolkit-server/src/constants.ts`). `stop-server.ts` ham shu origin'ni yuboradi.
2. [x] Auto-update o'chirildi:
   - `update-requested` e'tiborsiz qoldiriladi;
   - `@oclif/plugin-update` va `oclif.update.s3` olib tashlandi. Plugin'ning init hook'i har 14 kunda fonda `update --autoupdate`ni ishga tushirardi. Bu Mac'da 2026-10-10 dagi urinish `~/Library/Caches/httptoolkit-server/autoupdate.log`da bor;
   - oclif `dirname` endi `wirepane-server`. Release'da o'z launcher'imiz bor (`bin/httptoolkit-server`, Windows'da `bin\httptoolkit-server.cmd`, ikkalasini `scripts/assemble-server.cjs` yozadi). U `~/.local/share/*/client`dagi server'ga hech qachon o'tmaydi. Desktop va server'dagi `cleanupOldServers` faqat `wirepane-server` papkasiga qaraydi, rasmiy app'nikiga tegmaydi.
3. [x] UI build'i `Resources/httptoolkit-ui`da turadi va `wirepane://app`dan ochiladi (`httptoolkit-desktop/src/bundled-ui.ts`). Origin o'zgarmaydi, shuning uchun localStorage va IndexedDB saqlanib qoladi. UI `DISABLE_UPDATES=true` bilan yig'iladi: service worker yo'q.
4. [x] Server `../httptoolkit-server`dan yig'iladi (`scripts/build-server.sh`). `npm run build` endi `server:setup`ni chaqirmaydi, u faqat upstream'ning `npm start` va `npm test` oqimlarida qoldi.
5. [x] `extraMetadata.author` endi "Wirepane" (macOS'dagi copyright shundan olinadi). Linux `maintainer`: `Wirepane <azimxxm@users.noreply.github.com>` (2026-10-12).

Tekshirilgan (2026-10-12, 1.0.0, shu Mac'da):

- `codesign --verify --deep --strict` o'tdi (`Signature=adhoc`). `pkgutil --check-signature`: "no signature".
- `.pkg` ichida: bizning server (launcher, Node 24.19.0, bundle, `tls-impersonate`, `node-datachannel`), UI va 2549 ta siqilgan spec (`.json.br`). Siqilmagan `.json` spec yo'q.
- Yashirin ishga tushirish (vaqtinchalik `HOME`):
  - UI `wirepane://app`dan ochildi, "Startup failed" yo'q, status bar'da proxy porti bor;
  - proxy orqali yuborilgan so'rov View'da "IPFS: Version" bo'lib ko'rindi: UI siqilgan `ipfs` spec'ini o'z yo'li bilan ochdi. `/api/github.com/api.github.com.json` (5.7 MB) 40 ms'da ochildi;
  - userData `~/Library/Application Support/Wirepane`, log'lar `~/Library/Logs/Wirepane`, socket `wirepane-ctl.sock`. `httptoolkit-ctl status` socket orqali `running: true` qaytardi;
  - Settings → Status: "Wirepane 1.0.0", ostida "Based on HTTP Toolkit: app 1.27.2 · server 1.27.2 · UI …";
  - SIGTERM'dan keyin 1 s ichida app'ning 5 ta jarayoni (server bilan) to'xtadi.
- Collections (egasining 3 ta collection'i nusxasi bilan): ro'yxat, uchalasini ochish (ogohlantirishsiz), request saqlash, Postman, OpenAPI va HAR import, Postman va Bruno zip export, zip'ni qayta import, fayl yuklash va yuklab olish. Hammasi o'tdi.
- Windows va Linux server release'lari Mac'da yig'ib tekshirildi (`./scripts/build-server.sh win32-x64` va `linux-x64`): hamma native binary'lar o'z OS va CPU'si uchun. electron-builder config'i uchala tizim uchun schema'dan o'tdi, fayl nomlari kutilgandek.

**Qoldi:**

- **Birinchi CI yig'ishi.** Egasi "done" deganda push qilinadi, keyin Actions → Release → **Run workflow**. Windows va Linux installer'lari hali hech qachon yig'ilmagan: Mac'da faqat ularning server'i va config'i tekshirildi. Risklar: Windows'da Git Bash'dagi skriptlar (`.cmd` launcher'ni bash'dan ishga tushirish, zip ochish), Linux AppImage Ubuntu 24.04'da `--no-sandbox` talab qilishi mumkin.
- Egasi bilan: `.pkg`ni internetdan yuklab, toza foydalanuvchida o'rnatish va Gatekeeper oqimi (o'ng tugma → Open).
- Windows va Linux'da birinchi qo'lda sinov: o'rnatish, SmartScreen, app ochilishi, View, Send va collections.
- Windows'dagi ilovalar ro'yxatida va `.deb`/`.rpm`da versiya `1.27.2` (ichki versiya) ko'rinadi. Nom esa shunchaki "Wirepane".
- `nss/darwin`dagi `certutil` (Firefox'ning sertifikat bazasi uchun) x86_64, ya'ni Rosetta kerak. Upstream release'da ham shunday.
- Server bundle'ida build qilingan mashinadagi yo'l qoladi (`file:///Users/<user>/...`, Sentry'ning ishlatilmaydigan ESM loader'ida). Upstream'da ham shunday.
- Akkaunt kelgach: `ENABLE_SIGNING=true` yo'li (Developer ID, hardened runtime, notarize) sozlanadi.

### Publish ro'yxati: faqat egasi "done, publish" deganda

**Qoida (2026-10-12):** `.pkg`/`.app` faqat egasi "done, publish" deganda yig'iladi. Release'ga oid tuzatishlar shu ro'yxatga yoziladi va publish paytida bir yo'la qilinadi. Shu sanada boshlangan follow-up agent to'xtatildi, kodga tegilmagan. Quyidagilar o'shanda kod o'qib topilgan:

1. [x] **Electron userData rasmiy app bilan umumiy edi** (bajarildi 2026-10-12). `extraMetadata` endi name `wirepane`, productName `Wirepane` (`httptoolkit-desktop/package.json`): userData, log'lar, electron-store va single-instance lock `Wirepane` papkalariga ko'chdi, rasmiy app bilan umumiy narsa qolmadi.
   - Dev ham `~/Library/Application Support/Wirepane`ni ishlatadi (APFS katta-kichik harfni farqlamaydi). Egasining qarori: shunday qoladi, faqat o'rnatilgan app va `./start.sh` bir vaqtda ochilmaydi. CLAUDE.md'da yozildi.
   - ctl socket: bitta constant, `wirepane-ctl.sock` / `\\.\pipe\wirepane-ctl` (`CTL_SOCKET_NAME`, `CTL_PIPE_PATH` — `ui-operation-bridge.ts`, `bridge-client.ts` ham shuni ishlatadi).
   - Menu: "About Wirepane", "Hide Wirepane", "Quit Wirepane" (`menu.ts`).
   - Linux'da executable `wirepane` (`/opt/Wirepane/wirepane`, `/usr/bin/wirepane`), package nomi `wirepane`. Upstream'ning rpm skripti rasmiy app'ning `/usr/bin/httptoolkit` link'ini o'chirardi, endi o'zimizniki: `build-setup/wirepane-rpm-after-remove.sh`.
2. [x] **Hajm** (bajarildi 2026-10-12). `scripts/assemble-ui.cjs` spec'larni brotli bilan siqadi (387 MB → 28 MB), `bundled-ui.ts` ularni `createBrotliDecompress` bilan oqim qilib ochadi, MIME `.json`ligicha. App 911 → 525 MB, pkg 210 → 197 MiB. Spec'lar endi alohida imzolanmaydi (`mac.signIgnore`), app'ning o'z imzosi ularni baribir qamraydi.
3. [x] **`tls-impersonate`** (bajarildi 2026-10-12). Release'ning `node_modules`i build yuklagan Node 24.19.0 va uning o'z npm'i bilan o'rnatiladi: `scripts/stage-server-deps.cjs` server lockfile'idan faqat kerakli qismini oladi, keyin `npm ci` (`build/server-deps/<target>`). Tizim Node'iga tegilmaydi. `build-server.sh` uni release'ning node'i bilan `isSupported()` orqali tekshiradi.
4. ~~**Yashirin rejimdagi app SIGTERM bilan yopilmaydi**~~ — **xato emas** (2026-10-12). Tayyor app SIGTERM'da 2 s ichida yopiladi va server bilan birga hamma jarayonlari to'xtaydi. Oldingi kuzatish mening test xatoim edi: Bash tool zsh'da ishlaydi va `kill -TERM $PIDS` ro'yxatni bo'lmagan, shuning uchun signal yuborilmagan.
5. [x] **Build va tekshiruv** (2026-10-12): `./scripts/build-pkg.sh`, `codesign --verify --deep --strict`, `pkgutil --check-signature`, yashirin ishga tushirish. Natijalar yuqorida.
6. [x] **Egasi bilan** (2026-10-12): egasi `.pkg`ni o'z Mac'ida o'rnatib sindi, "ishlash yaxshi". Release egasi aytganda chiqadi (faqat macOS arm64 `.pkg`). 2026-10-12'da boshlangan release to'xtatildi, bo'sh draft o'chirildi.
7. [x] **Collections release'da ochilmasdi** (egasi o'rnatilgan `.pkg`da topdi, tuzatildi 2026-10-12). Birinchi ochishda "n.grammar is not a function", keyingilarida "Cannot access 'e\_' before initialization" chiqardi. Sabab: rspack ohm-js'ning ESM build'ini olgan, unda faqat `default` export bor. Dev'da Node `main` (CommonJS)ni yuklaydi, shuning uchun u yerda ishlardi. Tuzatish: `httptoolkit-server/rspack.config.js` `../bruno` ichidagi hamma narsani Node kabi resolve qiladi (`mainFields: ['main', 'module']`). `build-server.sh` endi har bir release'da `.bru` collection o'qish va Postman import'ini tekshiradi: tuzatishsiz bu tekshiruv yiqiladi.
8. [ ] **Windows va Linux: tez orada**, egasi aytganda (2026-10-12 qarori). Birinchi CI run'da (`38241881241`) mac build o'tdi, Windows va Linux build'lari tugashidan oldin bekor qilindi, ya'ni ular CI'da hali bir marta ham oxirigacha yig'ilmagan. Egasi aytganda: Actions → Release → Run workflow, keyin qo'lda sinov (yuqoridagi "Qoldi").
   - VPN helper'ning (sidecar) Windows va Linux build'lari ham shu run'da birinchi marta yig'iladi: 9-band.
9. [ ] **VPN rejimi release'da** (2026-10-13). Rust sidecar `wirepane-tunnel/` app ichida turadi: `Resources/wirepane-tunnel/wirepane-tunnel[.exe]`, server yo'lni `WIREPANE_TUNNEL_BINPATH`dan oladi. Publish oldidan:
   - **Local Network ruxsati, packaged app'da (egasi bilan).** macOS 15+ da Wirepane lokal tarmoqdagi telefonga UDP javob yuborishi uchun Local Network ruxsati kerak (TN3179). Terminal'dan ishga tushirilgan dev run bu cheklovdan ozod, shuning uchun dev'dagi muvaffaqiyat hech narsani isbotlamaydi. Tekshiruv: o'rnatilgan app'da (test pkg `~/Downloads/Wirepane-1.0.0-vpn-test-mac-arm64.pkg` yoki publish build'i) Intercept → iPhone or iPad → Capture all apps (VPN) → Start VPN capture, keyin:
     - ruxsat so'rovi chiqadimi va unda `NSLocalNetworkUsageDescription` matni ko'rinadimi ("Wirepane uses your local network to receive traffic from phones you connect with VPN mode.");
     - **Allow** bosilgach iPhone handshake qiladimi (sahifada "iPhone connected over VPN");
     - **Don't Allow** bosilsa nima bo'ladi va System Settings → Privacy & Security → Local Network'dan yoqilgach tuzaladimi;
     - macOS firewall (System Settings → Network → Firewall) yoqilgan Mac'da ham shu oqim o'tadimi (`wirepane-tunnel` uchun alohida so'rov chiqishi mumkin) [taxmin, sinalmagan].
     - Natijaga qarab README va `.github/release-notes.md`dagi "Local Network" matni to'g'rilanadi (hozir "so'raydi, Allow bosing" deb yozilgan, sinalmagan).
   - **Hajm.** Helper taxminan 1.1 MB: macOS arm64 app'ida 1,161,072 bayt (`panic = "unwind"`, `strip`, `lto`). Test `.pkg` 207,567,963 bayt (~198 MiB; 2-bandagi oldingi o'lchov 197 MiB edi). Windows va Linux helper'larining hajmi o'lchanmagan: build'dan keyin shu yerga yozish.
   - **Windows Firewall.** Birinchi VPN start'da Windows Defender Firewall `wirepane-tunnel.exe` uchun "Allow access" oynasini ko'rsatishi mumkin: **Private networks**ni belgilang. Oyna chiqmasa yoki tarmoq Public bo'lsa, inbound UDP `51873` uchun qoida kerak (port band bo'lsa `51874`–`51899`; iPhone sahifasi qaysi portni ishlatayotganini ko'rsatadi). Sinalmagan [taxmin].
   - **Linux `ufw` / `firewalld`.** `ufw` yoqilgan bo'lsa telefon handshake qila olmaydi: `sudo ufw allow 51873:51899/udp` (`firewalld`: `sudo firewall-cmd --add-port=51873-51899/udp`). Sinalmagan. Release notes'ga Linux uchun shu qatorni qo'shish, agar sinov tasdiqlasa.
   - **Windows va Linux sidecar build'lari CI'da hali ishlamagan.** `release.yml`dagi Rust qadami (`rustup target add`, keyin `build-release.sh` ichida `scripts/build-tunnel.sh <target>`) `12a5b106a`da qo'shildi. CI'dagi yagona run (`38241881241`, bekor qilingan, `7c24fab`) undan oldin bo'lgan, ya'ni sidecar CI'da hech bir tizimda, macOS'da ham yig'ilmagan. `x86_64-pc-windows-msvc` va `x86_64-unknown-linux-musl` (`musl-tools`) build'lari ham, sidecar'ning Windows va Linux'da ishlashi ham sinalmagan (`wirepane-tunnel/README.md`: faqat macOS arm64 yig'ilgan va sinalgan). Birinchi CI run'dan keyin har bir artifact'da `Resources/wirepane-tunnel/` bor-yo'qligini va helper ishga tushishini tekshirish.
   - **Matnlar.** README ("Telefon trafigi") va `.github/release-notes.md` ("VPN mode" bo'limi va o'zbekcha paragraf) VPN rejimini tasvirlaydi. Release notes shabloni hamma tizimni sanaydi: mac-only draft'ga ham VPN paragrafi ko'chiriladi (u "faqat macOS'da sinalgan" deydi, to'g'ri qoladi).

**Tarqatish (egasining qarori, 2026-10-12):** imzosiz **`.pkg`** installer, ichida ad-hoc imzolangan arm64 `Wirepane.app`. 2026-10-13 dan Intel Mac'lar uchun x64 `.pkg` ham bor (`./scripts/build-release.sh mac-x64`), ikkalasi macOS 13.5+ talab qiladi. Windows va Linux installer'lari ham imzosiz (2026-10-12). Apple Developer akkaunti yo'q, egasi ariza beradi. Shuning uchun:

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

## 8.5. v1.1: telefondagi hamma ilovani ko'rish (VPN rejimi)

**Nega (egasi, 2026-10-12):** proxy rejimida faqat iOS proxy sozlamasiga amal qiladigan ilovalar (Chrome, Safari) ko'rinadi. Flutter ilovalari, o'yinlar, UDP/QUIC va o'z socket'iga ega ilovalar Wirepane'ni chetlab o'tadi. Egasi "telefondan nima ketsa hammasini" ko'rmoqchi.

**Reja:** [`docs/research/phone-vpn-mode.md`](research/phone-vpn-mode.md).

**Holat (2026-10-12):** egasi boshladi ("Flutter ilovalarini ko'ra olishimiz kerak, Proxyman ko'ra olmaydi"). Haqiqiy iPhone'dagi test o'tdi: mitmproxy WireGuard rejimida Jett, Road24 va TelecomTV'ning o'z API'lari ochiq ko'rindi (research, 14-bo'lim). Qadamlar:

**Egasining qarori (2026-10-12):** avval WireGuard (bepul WireGuard ilovasi bilan, tez chiqadi), keyin **IKEv2**: iOS'ning o'z VPN turi, u Safari'dagi linkdan bitta profil (Wirepane CA + VPN) bo'lib o'rnatiladi, hech qanday ilova kerak emas. Bu asosiy iOS yo'li bo'ladi. Shuning uchun sidecar'ning kirish qismi almashtiriladigan qilib yoziladi: `wireguard` hozir, `ikev2` (ESP-over-UDP, NAT-T) keyin, TCP/DNS/QUIC/UDP yadrosi ikkalasiga umumiy.

1. [x] Rust sidecar `wirepane-tunnel/` (WireGuard → SOCKS5 + teglar → Mockttp, DNS, QUIC block, UDP relay) — tayyor (2026-10-12); egasining iPhone'i handshake qildi.
2. [x] Server: `wireguard-vpn` interceptor, kalitlar, QR config, lifecycle, event relay; Mockttp'da SOCKS custom-metadata.
3. [x] UI (iPhone; Android keyin): iPhone/Android sahifasida "Capture all apps (VPN)", QR, holat; qurilmani teg bo'yicha aniqlash; pinned host'lar (Apple push, iCloud) uchun passthrough.
4. [x] Packaging (Local Network ruxsatini egasi packaged app'da tekshiradi): sidecar'ni app ichiga qo'shish, `NSLocalNetworkUsageDescription`, packaged app'da Local Network ruxsatini tekshirish.
5. [ ] IKEv2 kirish qismi: IKE_SA_INIT/IKE_AUTH (server sertifikati Wirepane CA'dan), CHILD_SA (ESP AES-GCM), NAT-T, config payload (IP, DNS), DPD va rekey; `.mobileconfig` profil (CA + VPN payload) linkdan yuklanadi. Taxminan 2–3 hafta.

- Kichik Rust sidecar `wirepane-tunnel` mitmproxy_rs (MIT: boringtun + smoltcp) ustiga quriladi va root talab qilmaydi.
- Telefon rasmiy **WireGuard** ilovasini ishlatadi, sozlama QR orqali beriladi.
- TCP oqimlar Mockttp'ga SOCKS5 orqali asl manzil va qurilma tegi bilan uzatiladi.
- UDP, DNS va QUIC metadata'sini sidecar yig'adi va View'ga beradi.
- Asosiy xavf: macOS 15+ Local Network ruxsati.
- Hajm: 4–6 hafta (bitta dasturchi), QUIC SNI'siz MVP 3–4 hafta.

**Arzon interim yaxshilanishlar:**

- [x] **Raw tunnels** (2026-10-12): `account-store.ts`dagi `FEATURE_FLAGS = ['raw-tunnels']`. HTTP yoki TLS bo'lmagan TCP ulanishlar yopilmaydi, manziliga o'tadi va View'da "Non-HTTP connection to …" qatori bo'lib, o'z qurilmasi ostida ko'rinadi. Frida orqali ushlangan ilovalar proxy'ga SOCKS5 orqali ulanadi (upstream ikkalasini bitta flag bilan yoqadi).
  - **Qoldi, mockttp bug'i:** client yozishni tugatib FIN yuborsa (`printf … | nc`), mockttp tunnel'ni darhol yopadi va server javobi yo'qoladi (2 MB javobning 761 KB'i keldi). Sababi `passthroughSocket`da client socket'i `allowHalfOpen=false`. Tuzatish: raw TCP socket'larda `allowHalfOpen = true`, yaxshisi mockttp'ga upstream PR. Server tomonida `MockttpServer.prototype.passthroughSocket`ni o'rash ham sinab ko'rildi, lekin bu mockttp'ning ichki API'si va rspack bundle'ida alohida tekshirish kerak, shuning uchun qo'shilmadi.
- Pinning qiladigan host'lar uchun bir bosishda TLS passthrough.
- iPhone sahifasida qaysi trafik ko'rinishi va qaysi ko'rinmasligi haqida tushuntirish.
- [x] **Safari** (2026-10-12): iPhone sahifasining 3-qadami sertifikatni Safari'da ochishni aytadi (Chrome bo'sh sahifa ko'rsatadi), QR ostida default brauzer haqida ogohlantirish bor, 3-qadamda AirDrop uchun "Save certificate (.crt)" tugmasi.

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

- [x] **Test type'lari** (2026-10-12): `(cd httptoolkit-ui && npx tsc -p test/unit --noEmit)` xatosiz. `test/unit/tsconfig.json`da `skipLibCheck` (dev server'ning ForkTsChecker'i kabi) va `.tsx` spec'lar ham tekshiriladi.
- [x] **O'z dialoglarimiz** (2026-10-12): `alert()` va `confirm()` o'rniga `model/ui/dialogs.ts` (`messageDialog`, `confirmDialog`) va `components/common/dialog-host.tsx`. Yangi kodda ham shularni ishlatish kerak. Faqat `src/index.html`dagi startup `alert()` qoldi: u bundle umuman ochilmaganda ishlaydi, React yo'q paytda. Uning matnida hali httptoolkit.com va github.com/httptoolkit havolalari bor.
- [x] **Dev UI porti** (2026-10-12): 8080 → 45458 (`automation/webpack.dev.ts`, `start.sh`), server'ning 45456/45457 portlari yonida.

- **Brend:** `wirepane.com`, `.dev`, `.app` domenlarini olish va trademark tekshiruvi (USPTO, WIPO).
- **Git:** egasi so'rasa `feature/rebrand`ni push qilish yoki `main`ga merge qilish.
- **Upstream sync:** `./sync-upstream.sh` dan keyin `./setup.sh` (u Bruno'ni ham qayta build qiladi). `// wirepane:` izohli joylarda conflict bo'lishi mumkin.
