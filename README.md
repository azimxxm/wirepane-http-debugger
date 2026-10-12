# Wirepane

Developerlar va QA uchun bepul, ochiq kodli HTTP(S) debugger. U brauzer, iPhone, Android, Docker va boshqa ilovalarning trafigini ushlaydi va ko'rsatadi, mock va rewrite qiladi. Proxyman'ga muqobil.

**Maqsad:** 5 ta yoki 10 ta tool o'rniga **bitta dastur**. Wirepane trafikni ushlash va debug qilish (Proxyman, Charles), API client, collections, testlar, mock va hujjat (Postman, Bruno) hamda file orqali ulashishni bitta joyda qiladi. U developerlar, QA va boshlovchilar uchun bepul bo'ladi va odamlarni pullik tool'larga qaramlikdan xalos qiladi. Bruno kodi bizning kodimiz sifatida olinadi va kerakli joylarda o'zgartiriladi; Bruno bilan 1:1 bo'lishi shart emas. Asosi — [HTTP Toolkit](https://httptoolkit.com) ochiq kodi. Hammasi bitta repoda: UI, server va desktop bitta app bo'lib ishga tushadi. Oxirgi natija — bitta o'rnatiladigan `Wirepane.app` (bundle ID: `com.wirepane.app`).

> Wirepane [HTTP Toolkit](https://httptoolkit.com) asosida yasalgan, lekin rasmiy HTTP Toolkit emas va u bilan bog'liq emas.

## Asosiy source'lar

| Papka                  | Upstream                                                                              | Vazifasi                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `httptoolkit-ui/`      | [httptoolkit/httptoolkit-ui](https://github.com/httptoolkit/httptoolkit-ui)           | Interfeys (React, MobX, webpack)                                                                                                                    |
| `httptoolkit-server/`  | [httptoolkit/httptoolkit-server](https://github.com/httptoolkit/httptoolkit-server)   | Proxy'ni boshqarish, interceptor'lar                                                                                                                |
| `httptoolkit-desktop/` | [httptoolkit/httptoolkit-desktop](https://github.com/httptoolkit/httptoolkit-desktop) | Electron oyna                                                                                                                                       |
| npm dependency         | [httptoolkit/mockttp](https://github.com/httptoolkit/mockttp)                         | Proxy engine (HTTP/HTTPS MITM)                                                                                                                      |
| `bruno/`               | [usebruno/bruno](https://github.com/usebruno/bruno) (MIT)                             | Collections va file orqali ulashish: package'lari (`bruno-converters`, `bruno-lang`, `bruno-js`, `bruno-cli`) ishlatiladi. App sifatida yig'ilmaydi |

Asosiy loyiha va issue'lar: [httptoolkit/httptoolkit](https://github.com/httptoolkit/httptoolkit).
Upstream kod `git subtree --squash` orqali qo'shilgan. Ya'ni kodning hammasi shu repoda, upstream commit tarixi esa olinmagan.

Bruno — open-core loyiha. GitHub'dagi kod to'liq MIT litsenziyasida, shuning uchun uni AGPL ilovamizda ishlatish mumkin; faqat ularning `license.md` copyright'i saqlanadi. Pullik Pro va Ultimate feature'lari (Git UI, secret manager, test hisobotlari, SSO) ochiq repo'da yo'q. Kerak bo'lganlarini o'zimiz yozamiz.

## Ishga tushirish

Kerak: macOS, Node.js 24, git.

```bash
git clone https://github.com/azimxxm/wirepane.git ~/Documents/wirepane
cd ~/Documents/wirepane
./setup.sh   # bir marta: Bruno package'larini build qiladi (~25 s, ~290 MB), keyin uchala papkada npm ci
./start.sh   # app ochiladi. Cmd+Q bosilsa, hammasi to'xtaydi
```

Finder'dan ochish: `Start Wirepane.command` faylini ikki marta bosing. Log'lar `logs/` papkada saqlanadi.

**Boshqa Mac'da davom ettirish:** `git pull` → `./setup.sh` → `./start.sh`. `setup.sh` faqat dependency'lar o'zgarganda kerak.

## Nimani qayerda o'zgartirish

| Nima                 | Qayerda                   | Qachon ko'rinadi                              |
| -------------------- | ------------------------- | --------------------------------------------- |
| Ekranlar, dizayn     | `httptoolkit-ui/src`      | darhol (hot reload)                           |
| Interceptor'lar, API | `httptoolkit-server/src`  | server o'zi qayta ishga tushadi               |
| Oyna, menu, Electron | `httptoolkit-desktop/src` | `./start.sh` qayta ishga tushirilgandan keyin |

## Telefon trafigi

Eng oson yo'l: app'da **Intercept** → **iPhone or iPad** yoki **Android** kartasini bosing. Ekranda Mac IP'si, port, sertifikat uchun QR va qadamlar chiqadi. Telefon ulangach, "iPhone connected" holati ham ko'rinadi. Port app qayta yuklanganda ham o'zgarmaydi.

Qo'lda sozlash: proxy Mac'da ishlaydi (port status bar'da ko'rinadi) va Wi-Fi tarmog'idan ochiq. Mac IP'sini bilish: `ipconfig getifaddr en0`.

- **iPhone:**
  1. Wi-Fi → (i) → Configure Proxy → Manual. Server: Mac IP, port: status bar'dagi port.
  2. Safari'da `http://wirepane.cert/certificate` ni oching va profilni yuklab oling. Bu manzil faqat proxy sozlangandan keyin ochiladi, chunki unga Wirepane'ning o'zi javob beradi.
  3. Settings → General → VPN & Device Management bo'limida profilni o'rnating.
  4. Settings → General → About → Certificate Trust Settings bo'limida **Wirepane CA**ni yoqing.
  5. Tekshirish: Safari'da `https://wirepane.cert` "You're being intercepted by Wirepane" deb chiqishi kerak.
- **Android:** app'da **Android Device via QR code** (root shart emas) yoki **Android Device via ADB**ni tanlang.

Ish tugagach, telefondagi proxy'ni **Off** qiling.

## Upstream yangilanishlarini olish

```bash
./sync-upstream.sh   # 3 ta upstream repo'dan yangi kodni oladi
./setup.sh
```

O'zgartirgan kodingiz saqlanib qoladi. Conflict chiqsa, uni oddiy `git merge`dagidek hal qilasiz.

## Yo'l xaritasi: bitta `.app`

- [x] Hamma kod bitta repoda va local source'dan bitta app bo'lib ishlaydi (dev rejim).
- [ ] O'z brendimiz — **Wirepane**:
  - [x] Nom, GitHub repo (`azimxxm/wirepane`), bundle ID (`com.wirepane.app`), `productName`, oyna va menu sarlavhalari, UI, terminal va CLI/MCP matnlari.
  - [x] Logo va ikonka. Manbasi `brand/icon.svg`. `./brand/build-icons.sh` undan barcha fayllarni (`.icns`, `.ico`, PNG, UI logosi, loading wordmark) qayta yasaydi.
  - [ ] UI redesign ([reja](docs/design-plan.md), [tahlil](docs/design/critique-2026-10-10.md)). Rejada 3 bosqich bor:
    1. Logoga mos ranglar va shriftlar.
    2. Status bar, sahifa sarlavhalari, Intercept'ni qadamli boshlash ekraniga aylantirish va bo'sh holatlar.
    3. Menu bar, ⌘K va ⌘,.
  - [ ] `wirepane.com`, `wirepane.dev` va `wirepane.app` domenlarini olish (2026-10-10 holatida bo'sh edi). Trademark tekshiruvi (USPTO, WIPO).
  - "HTTP Toolkit" nomi original loyihaga tegishli. AGPL kodni ishlatishga ruxsat beradi, lekin nomni ishlatishga emas. `LICENSE` va "based on HTTP Toolkit" degan attribution saqlanib qoladi.
  - Faqat foydalanuvchi ko'radigan joylar o'zgaradi. Quyidagilar ataylab "HTTP Toolkit"ligicha qoladi:
    - Rules faylidagi `HTTP Toolkit Rules` sarlavhasi.
    - Android'dagi HTTP Toolkit ilovasi (Play Store'dagi asl nomi).
    - httptoolkit.com docs havolalari.
    - Ichki nomlar: package'lar, `httptoolkit` config papkasi, `HTK_*` env'lar.

    Shunda `sync-upstream.sh` ham kamroq conflict beradi. "HTTP Toolkit Pro" matnlari esa Pro feature'lar ochilganda olib tashlanadi.

- [ ] O'zimizning `.app`imizni yig'ish. Buning uchun:
  1. `httptoolkit-server/src/constants.ts` — o'z UI origin'imizga ruxsat berish (hozir faqat `https://app.httptoolkit.tech` ruxsat etilgan).
  2. Auto-update'ni o'chirish: `httptoolkit-server/src/index.ts` (`update-requested`) va `package.json` → `oclif.update`. Aks holda rasmiy server bizning server o'rniga yuklanib qoladi.
  3. UI build'ini (`httptoolkit-ui` → `npm run build`) app ichiga qo'shish va `APP_URL`ni unga yo'naltirish.
  4. `httptoolkit-desktop/package.json` faylida signing va notarize sozlamalarini o'zgartirish (`appId` va `productName` allaqachon Wirepane). `build-setup/setup-server.ts` server'ni GitHub release'dan yuklamasin, `../httptoolkit-server`dan yig'sin.
  5. **Tarqatish: `.pkg` installer, Apple Developer akkauntisiz.** Akkaunt hali yo'q (egasi ariza beradi), shuning uchun:
     - app ad-hoc imzolanadi va imzosiz `.pkg` ichida Apple Silicon (`arm64`) uchun tarqatiladi;
     - notarize qilinmaydi va build sertifikatsiz Mac'da ishlashi kerak.

     Brauzerdan yuklangan `.pkg`ni Gatekeeper birinchi marta to'xtatadi: o'ng tugma → Open yoki System Settings → Privacy & Security → **Open Anyway**. `curl … | sh` bilan o'rnatilsa ogohlantirish chiqmaydi. Akkaunt kelgach, Developer ID imzosi va notarize qo'shiladi.
- [x] Barcha Pro feature'lar hamma uchun bepul. Akkaunt, login va to'lov yo'q. Map Local, Map Remote, mock, rewrite, delay, block, Settings (proxy, connection, API, themes), saqlanadigan rules, HAR import/export va MCP/CLI cheklovsiz ishlaydi.
- [ ] Proxyman'dagi feature'lar:
  - [x] Telefon ulash ekrani: iPhone va Android uchun IP, port, sertifikat QR'i va jonli holat, port qayta yuklashda o'zgarmaydi.
  - **Qo'shish kerak:**
    - P1: Access Control (LAN'dan kim ulana olishi), macOS system proxy toggle, iOS Simulator auto-setup.
    - P2: Highlight/Comment, Diff, Network Conditions, DNS Spoofing.
    - P3: Scripting, Reverse Proxy, native Swift + SwiftNIO versiya.
- [x] Send: Form, Multipart (fayl, rasm, media), Binary, GraphQL (schema, autocomplete, docs) va WebSocket client ([reja](docs/send-v2-plan.md)).
- [ ] Collections va file orqali ulashish, Bruno package'lari asosida ([reja](docs/collections-plan.md)): API'ni hujjati bilan bitta faylga export qilish (Postman v2.1 JSON yoki Bruno). Secret'lar faylga tushmaydi. Oluvchi faylni import qilsa, hammasi tayyor ochiladi.
- [ ] Postman'dan olinadigan feature'lar ([tadqiqot](docs/research/postman.md)):
  - P1:
    - Ushlangan trafikni collection sifatida saqlash.
    - `pm.test` bilan mos assertion'lar, jonli trafik uchun ham.
    - Postman v2.1 import va export.
    - Variables va environments, secret'larni lokal saqlash bilan.
    - Export'larda secret'larni yashirish.
    - Auth helper'lar.
  - P2:
    - Aqlliroq mock'lar.
    - OpenAPI kontrakt tekshiruvi.
    - Collection runner.
    - CLI va MCP orqali yozish operatsiyalari.
    - `.http`, Hurl va Playwright export.
    - Umumiy cookie jar.

## Eslatmalar

- **License:** AGPL-3.0 (`LICENSE`). App'ni boshqalarga tarqatsangiz, uning source kodi ham ochiq bo'lishi shart. Bu repo public, shuning uchun bu shart bajarilgan.
- **Xavfsizlik:** dev rejimda server token'siz ishlaydi, proxy esa butun Wi-Fi tarmog'iga ochiq. Ishonchsiz tarmoqda ishlatmang.
- Wirepane'ning o'z CA'si bor: **Wirepane CA** (`~/Library/Preferences/httptoolkit/wirepane-ca.pem`). Rasmiy HTTP Toolkit'ning `ca.pem` fayliga tegilmaydi. Oldin "HTTP Toolkit CA" o'rnatilgan telefonlarga yangi sertifikatni bir marta o'rnatish kerak.
- Apple Silicon'da hammasi native `arm64`da ishlaydi, Rosetta shart emas.
- Server Node `v24.19.0`ni talab qiladi. Boshqa 24.x versiyalarda ham ishlaydi, faqat `EBADENGINE` ogohlantirishi chiqadi.
