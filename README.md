# Wirepane

Developerlar va QA uchun bepul, ochiq kodli HTTP(S) debugger. U brauzer, iPhone, Android, Docker va boshqa ilovalarning trafigini ushlaydi va ko'rsatadi, mock va rewrite qiladi. Proxyman'ga muqobil.

**Maqsad:** 5 ta yoki 10 ta tool o'rniga **bitta dastur**. Wirepane trafikni ushlash va debug qilish (Proxyman, Charles), API client, collections, testlar, mock va hujjat (Postman, Bruno) hamda file orqali ulashishni bitta joyda qiladi. U developerlar, QA va boshlovchilar uchun bepul bo'ladi va odamlarni pullik tool'larga qaramlikdan xalos qiladi. Bruno kodi bizning kodimiz sifatida olinadi va kerakli joylarda o'zgartiriladi; Bruno bilan 1:1 bo'lishi shart emas. Asosi — [HTTP Toolkit](https://httptoolkit.com) ochiq kodi. Hammasi bitta repoda: UI, server va desktop bitta app bo'lib ishga tushadi. Oxirgi natija — macOS, Windows va Linux uchun bitta o'rnatiladigan dastur (macOS'da `Wirepane.app`, bundle ID: `com.wirepane.app`).

> Wirepane [HTTP Toolkit](https://httptoolkit.com) asosida yasalgan, lekin rasmiy HTTP Toolkit emas va u bilan bog'liq emas.

## O'rnatish

Installer [GitHub Releases](https://github.com/azimxxm/wirepane-http-debugger/releases) sahifasida chiqadi (birinchi release hali chiqmagan). Eng oxirgi versiyani oching va faylni yuklab oling:

| Tizim                                                  | Fayl                               |
| ------------------------------------------------------ | ---------------------------------- |
| macOS 12 yoki yangiroq, Apple Silicon (M1 va yangiroq) | `Wirepane-<versiya>-mac-arm64.pkg` |
| Windows 10 va 11, x64                                  | tez orada                          |
| Linux, x64                                             | tez orada                          |

Installer hali imzolanmagan: Apple Developer akkaunti ham, kod imzolash sertifikati ham yo'q. Shuning uchun birinchi ochishda macOS ogohlantiradi: `.pkg`ni ikki marta bosing, macOS uni tekshira olmaganini aytsa, `.pkg` ustida o'ng tugma → **Open** → **Open**, yoki System Settings → Privacy & Security → **Open Anyway**. Keyin qadamlardan o'ting: app `/Applications`ga o'rnatiladi ("faqat men uchun" tanlansa, `~/Applications`ga). App ham shunday to'xtatilsa, unda ham o'ng tugma → **Open**.

`.pkg`ning SHA-256'i release sahifasida yozilgan. HTTPS trafikni ko'rish uchun qurilma **Wirepane CA** sertifikatiga ishonishi kerak: buni app'dagi **Intercept** sahifasi har bir qurilma uchun ko'rsatadi.

## Asosiy source'lar

| Papka                  | Upstream                                                                              | Vazifasi                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `httptoolkit-ui/`      | [httptoolkit/httptoolkit-ui](https://github.com/httptoolkit/httptoolkit-ui)           | Interfeys (React, MobX, webpack)                                                                                                                    |
| `httptoolkit-server/`  | [httptoolkit/httptoolkit-server](https://github.com/httptoolkit/httptoolkit-server)   | Proxy'ni boshqarish, interceptor'lar                                                                                                                |
| `httptoolkit-desktop/` | [httptoolkit/httptoolkit-desktop](https://github.com/httptoolkit/httptoolkit-desktop) | Electron oyna                                                                                                                                       |
| npm dependency         | [httptoolkit/mockttp](https://github.com/httptoolkit/mockttp)                         | Proxy engine (HTTP/HTTPS MITM)                                                                                                                      |
| `bruno/`               | [usebruno/bruno](https://github.com/usebruno/bruno) (MIT)                             | Collections va file orqali ulashish: package'lari (`bruno-converters`, `bruno-lang`, `bruno-js`, `bruno-cli`) ishlatiladi. App sifatida yig'ilmaydi |
| `wirepane-tunnel/`     | O'zimizniki, [mitmproxy_rs](https://github.com/mitmproxy/mitmproxy_rs) (MIT)          | VPN rejimi: telefon trafigini WireGuard orqali qabul qiladigan kichik Rust helper, root kerak emas ([tavsif](wirepane-tunnel/README.md))            |

Asosiy loyiha va issue'lar: [httptoolkit/httptoolkit](https://github.com/httptoolkit/httptoolkit).
Upstream kod `git subtree --squash` orqali qo'shilgan. Ya'ni kodning hammasi shu repoda, upstream commit tarixi esa olinmagan.

Bruno — open-core loyiha. GitHub'dagi kod to'liq MIT litsenziyasida, shuning uchun uni AGPL ilovamizda ishlatish mumkin; faqat ularning `license.md` copyright'i saqlanadi. Pullik Pro va Ultimate feature'lari (Git UI, secret manager, test hisobotlari, SSO) ochiq repo'da yo'q. Kerak bo'lganlarini o'zimiz yozamiz.

## Ishga tushirish

Kerak: macOS, Node.js 24, git. VPN rejimi (Telefon trafigi bo'limi) uchun yana Rust: [rustup.rs](https://rustup.rs). Rust bo'lmasa ham app ishlaydi, faqat VPN rejimi o'chiq turadi.

```bash
git clone https://github.com/azimxxm/wirepane-http-debugger.git ~/Documents/wirepane-http-debugger
cd ~/Documents/wirepane-http-debugger
./setup.sh   # bir marta: Bruno package'larini build qiladi (~25 s, ~290 MB), keyin uchala papkada npm ci, Rust bo'lsa VPN helper'ni ham yig'adi
./start.sh   # app ochiladi. Cmd+Q bosilsa, hammasi to'xtaydi
```

Finder'dan ochish: `Start Wirepane.command` faylini ikki marta bosing. Log'lar `logs/` papkada saqlanadi.

**Boshqa Mac'da davom ettirish:** `git pull` → `./setup.sh` → `./start.sh`. `setup.sh` faqat dependency'lar o'zgarganda kerak.

### Installer'larni yig'ish

Har bir installer o'z tizimida yig'iladi:

```bash
./scripts/build-release.sh mac     # Apple Silicon Mac'da: .pkg va .zip (./scripts/build-pkg.sh ham shuni qiladi)
./scripts/build-release.sh win     # Windows x64'da, Git Bash ichida: setup .exe va .zip
./scripts/build-release.sh linux   # Linux x64'da: .AppImage, .deb va .rpm (.rpm uchun rpmbuild kerak)
```

Skript Bruno, server, UI va desktop'ni yig'adi va oxirida fayllarni ko'rsatadi: `httptoolkit-desktop/dist/Wirepane-<versiya>-...`. Versiya — repo ildizidagi `VERSION` fayli (hozir `1.0.0`). Server ham, UI ham shu repo'dagi koddan yig'iladi. Internetdan faqat Node.js (har tizim uchun bir marta, `build/cache`da saqlanadi) va npm package'lari yuklanadi. Sertifikat yoki akkaunt kerak emas. Mac'da yig'ish bir necha daqiqa oladi.

**GitHub Actions:** `.github/workflows/release.yml` uchala tizimda yig'adi va hamma fayllarni draft GitHub release'ga (`v<versiya>`) qo'yadi. Ishga tushirish: Actions → Release → **Run workflow** (versiya bo'sh qolsa, `VERSION`dan olinadi) yoki `v1.0.0` kabi tag push qilish. Draft tekshirilgach, qo'lda **Publish** qilinadi.

## Nimani qayerda o'zgartirish

| Nima                 | Qayerda                   | Qachon ko'rinadi                              |
| -------------------- | ------------------------- | --------------------------------------------- |
| Ekranlar, dizayn     | `httptoolkit-ui/src`      | darhol (hot reload)                           |
| Interceptor'lar, API | `httptoolkit-server/src`  | server o'zi qayta ishga tushadi               |
| Oyna, menu, Electron | `httptoolkit-desktop/src` | `./start.sh` qayta ishga tushirilgandan keyin |

## Telefon trafigi

Eng oson yo'l: app'da **Intercept** → **iPhone or iPad** yoki **Android** kartasini bosing. Ekranda Mac'ning manzili, port, QR code va qadamlar chiqadi. Telefon ulangach, "iPhone connected" holati ham ko'rinadi. Port app qayta yuklanganda ham o'zgarmaydi.

iPhone va iPad'ni ulashning ikki yo'li bor. Yo'lni sahifaning tepasida tanlaysiz. Ikkalasida ham telefon Mac bilan bir Wi-Fi tarmog'ida bo'lishi kerak.

| Yo'l                                | Nimani ushlaydi                                                                       | Nima kerak                  |
| ----------------------------------- | ------------------------------------------------------------------------------------- | --------------------------- |
| **Capture all apps (VPN)**, tavsiya | Telefondagi hamma ilova: Flutter ilovalari, o'yinlar va o'z ulanishi bor ilovalar ham | Bepul **WireGuard** ilovasi |
| **Wi-Fi proxy**                     | Faqat iPhone'ning Wi-Fi proxy sozlamasiga amal qiladigan ilovalar (masalan, Safari)   | Qo'shimcha ilova kerak emas |

### Capture all apps (VPN)

Wirepane Mac'da WireGuard VPN server ishga tushiradi. iPhone butun trafigini shu orqali yuboradi, shuning uchun Wi-Fi proxy'ni chetlab o'tadigan ilovalar ham ko'rinadi. Mac'da root yoki parol kerak emas.

1. iPhone'ga App Store'dan bepul **WireGuard** ilovasini o'rnating.
2. Wirepane'da **Intercept** → **iPhone or iPad** → **Capture all apps (VPN)** → **Start VPN capture** bosing. Wirepane iPhone uchun QR code ko'rsatadi.
3. iPhone'da WireGuard → **+** → **Create from QR code**. QR'ni WireGuard'ning o'zida skanerlang va tunnel'ga nom bering. iOS VPN sozlamasini qo'shishga ruxsat so'rasa, **Allow** bosing. Keyin tunnel'ni yoqing.
4. HTTPS uchun sertifikatni o'rnating: pastdagi "Sertifikat" qadamlari. Safari'dagi manzil tunnel yoqilgandan keyin ochiladi.
5. Wirepane'da "iPhone connected over VPN" chiqadi. **View requests** tugmasi so'rovlarni View'da ochadi.

Ish tugagach, WireGuard'da tunnel'ni **Off** qiling. Aks holda Wirepane ishlamayotganda telefonda internet bo'lmaydi. Sertifikat o'rnatilgan holda qolishi mumkin.

Bilib qo'ying:

- **Sertifikat kerak.** HTTPS ichini ko'rish uchun **Wirepane CA** baribir o'rnatilishi kerak. Sertifikat Wi-Fi proxy yo'lidagi bilan bir xil: bir marta o'rnatilsa, ikkala yo'lda ishlaydi.
- **Pinning.** Sertifikatni pin qiladigan ilovalar (masalan, ba'zi ilovalarning o'z API'si) yopiq qoladi: View'da faqat host ko'rinadi, ichi emas. Apple'ning push, iCloud va joylashuv xizmatlari ham pin qiladi: Wirepane ularni tegmasdan o'tkazadi, shuning uchun telefon ishlashda davom etadi, lekin ularning ichi ko'rinmaydi.
- **QR bir marta skanerlanadi.** Keyingi safar Wirepane'da **Start VPN capture** bosib, WireGuard'da tunnel'ni yoqish yetadi. Mac'ning manzili o'zgargan bo'lsa (boshqa Wi-Fi), **Show a new QR code** bilan yangisini oling.
- **QR code maxfiy.** Unda shu qurilmaning private key'i bor, uni boshqalarga ko'rsatmang. Ishlatilmaydigan qurilmani VPN sahifasidagi **Devices set up for the VPN** kartasida **Remove** qiling: u VPN'ini yo'qotadi, qayta ulash uchun yangi QR code kerak.
- **Local Network.** macOS 15 va yangiroq'da birinchi marta Wirepane lokal tarmoqqa kirish ruxsatini so'raydi. **Allow** bosing: ruxsatsiz iPhone ulana olmasligi mumkin. Keyin ham yoqish mumkin: System Settings → Privacy & Security → Local Network.
- **Ulanmasa.** Telefon va Mac bir Wi-Fi'da ekanini, Local Network ruxsatini va firewall UDP portni to'smayotganini tekshiring. Port iPhone sahifasida ko'rinadi, odatda UDP `51873`.

### Wi-Fi proxy

Proxy Mac'da ishlaydi (port status bar'da ham ko'rinadi) va Wi-Fi tarmog'idan ochiq. Mac'ning manzili iPhone sahifasidagi **Server** maydonida, port **Port** maydonida turadi.

1. Wi-Fi → (i) → Configure Proxy → Manual. Server va Port: iPhone sahifasida ko'rsatilgan qiymatlar. Authentication: off.
2. HTTPS uchun sertifikatni o'rnating: pastdagi "Sertifikat" qadamlari.

Ish tugagach, telefondagi proxy'ni **Off** qiling.

### Sertifikat

Ikkala yo'l uchun bir xil:

1. Safari'da `http://wirepane.cert/certificate` ni oching va profilni yuklab oling. Bu manzil faqat proxy sozlangandan yoki VPN tunnel yoqilgandan keyin ochiladi, chunki unga Wirepane'ning o'zi javob beradi.
2. Settings → General → VPN & Device Management bo'limida profilni o'rnating.
3. Settings → General → About → Certificate Trust Settings bo'limida **Wirepane CA**ni yoqing.
4. Tekshirish: Safari'da `https://wirepane.cert` "You're being intercepted by Wirepane" deb chiqishi kerak.

### Android

App'da **Android Device via QR code** (root shart emas) yoki **Android Device via ADB**ni tanlang. Wirepane'ning WireGuard VPN rejimi hozircha faqat iPhone va iPad uchun.

## Upstream yangilanishlarini olish

```bash
./sync-upstream.sh   # 3 ta upstream repo'dan yangi kodni oladi
./setup.sh
```

O'zgartirgan kodingiz saqlanib qoladi. Conflict chiqsa, uni oddiy `git merge`dagidek hal qilasiz.

## Yo'l xaritasi: bitta `.app`

- [x] Hamma kod bitta repoda va local source'dan bitta app bo'lib ishlaydi (dev rejim).
- [ ] O'z brendimiz — **Wirepane**:
  - [x] Nom, GitHub repo (`azimxxm/wirepane-http-debugger`), bundle ID (`com.wirepane.app`), `productName`, oyna va menu sarlavhalari, UI, terminal va CLI/MCP matnlari.
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

- [x] O'zimizning `.app`imizni yig'ish (2026-10-12). `./scripts/build-pkg.sh` imzosiz `.pkg` yasaydi:
  1. Server o'z kodimizdan yig'iladi (`scripts/build-server.sh`), GitHub'dagi rasmiy release yuklanmaydi. Bruno package'lari server bundle'i ichida.
  2. Server o'zini yangilamaydi: `update-requested` e'tiborsiz qoldiriladi, oclif'ning update plugin'i olib tashlandi. Server'ni ishga tushiruvchi skript faqat app ichidagi server'ni ishga tushiradi. Rasmiy app'ning `~/.local/share/httptoolkit-server` papkasiga tegilmaydi.
  3. UI app ichida va `wirepane://app` manzilidan ochiladi. Release server faqat shu origin'ga ruxsat beradi. Sozlamalar va Send tab'lari app qayta ochilganda ham saqlanadi.
  4. App ad-hoc imzolanadi, `.pkg` imzosiz, notarize yo'q. Build sertifikatsiz Mac'da ishlaydi.
  - [ ] Birinchi release **v1.0.0**: faqat macOS arm64 `.pkg`, egasi aytganda. Egasi `.pkg`ni o'z Mac'ida o'rnatib sinadi (2026-10-12).
  - [ ] Windows (setup `.exe`, `.zip`) va Linux (`.AppImage`, `.deb`, `.rpm`): **tez orada**, egasi aytganda chiqariladi. Hammasi imzosiz; `./scripts/build-release.sh <mac|win|linux>` va GitHub Actions'dagi `release.yml` tayyor. Birinchi CI run'da mac build o'tdi, Windows va Linux build'lari tugashidan oldin to'xtatildi.
  - Akkaunt kelgach: Developer ID imzosi, hardened runtime va notarize. Ular `ENABLE_SIGNING=true` bilan yoqiladigan yo'lga qo'shiladi, imzosiz yo'l zaxira bo'lib qoladi.
- [x] Barcha Pro feature'lar hamma uchun bepul. Akkaunt, login va to'lov yo'q. Map Local, Map Remote, mock, rewrite, delay, block, Settings (proxy, connection, API, themes), saqlanadigan rules, HAR import/export va MCP/CLI cheklovsiz ishlaydi.
- [ ] Proxyman'dagi feature'lar:
  - [x] Telefon ulash ekrani: iPhone va Android uchun IP, port, sertifikat QR'i va jonli holat, port qayta yuklashda o'zgarmaydi.
  - [x] VPN rejimi, 1-bosqich (WireGuard): iPhone'dagi hamma ilovaning trafigi, jumladan Flutter ilovalari ham, proxy sozlamasiz ko'rinadi. Telefonda bepul WireGuard ilovasi kerak ([reja](docs/plans/2026-10-12-iphone-fixes-and-vpn.md), [tadqiqot](docs/research/phone-vpn-mode.md)). Qoldi: packaged app'da macOS Local Network ruxsatini tekshirish; Windows va Linux'da sinash.
  - [ ] VPN rejimi, 2-bosqich (IKEv2): qo'shimcha ilovasiz. Safari'dagi linkdan bitta profil (Wirepane CA + VPN) o'rnatiladi. Android uchun VPN rejimi ham shundan keyin.
  - **Qo'shish kerak:**
    - P1: Access Control (LAN'dan kim ulana olishi), macOS system proxy toggle, iOS Simulator auto-setup.
    - P2: Highlight/Comment, Diff.
  - [x] VPN rejimi, 1-bosqich (2026-10-12): WireGuard orqali telefondagi hamma ilova, Flutter ilovalari ham ([tadqiqot](docs/research/phone-vpn-mode.md)).
  - [ ] VPN rejimi ustidagi Rust tool'lari ([reja](docs/plans/2026-10-13-rust-network-tools.md)): ilovasiz IKEv2, Network Conditions, DNS ko'rinishi, DNS Spoofing va bloklash, JA4 fingerprint, UDP ko'rinishi, HTTP/3 ochish, pcap eksport, Android VPN.
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
- Dev rejimdagi app (`./start.sh`) va o'rnatilgan app bitta sozlamalar papkasini ishlatadi (`~/Library/Application Support/Wirepane`). Shuning uchun ular bir vaqtda ochilmaydi: ikkinchisi darrov yopiladi.
- Server Node `v24.19.0`ni talab qiladi. Boshqa 24.x versiyalarda ham ishlaydi, faqat `EBADENGINE` ogohlantirishi chiqadi.
