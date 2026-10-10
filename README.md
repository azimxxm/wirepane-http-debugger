# HTTP Toolkit — shaxsiy build

**Maqsad:** [HTTP Toolkit](https://httptoolkit.com) ochiq kodi asosida Proxyman'ga o'xshash, bepul HTTP debugger yasash. Hammasi bitta repoda: UI, server va desktop bitta app bo'lib ishga tushadi. Oxirgi natija — bitta o'rnatiladigan `.app` paket.

> Bu rasmiy HTTP Toolkit emas. Original loyiha: [httptoolkit.com](https://httptoolkit.com).

## Asosiy source'lar

| Papka                  | Upstream                                                                              | Vazifasi                             |
| ---------------------- | ------------------------------------------------------------------------------------- | ------------------------------------ |
| `httptoolkit-ui/`      | [httptoolkit/httptoolkit-ui](https://github.com/httptoolkit/httptoolkit-ui)           | Interfeys (React, MobX, webpack)     |
| `httptoolkit-server/`  | [httptoolkit/httptoolkit-server](https://github.com/httptoolkit/httptoolkit-server)   | Proxy'ni boshqarish, interceptor'lar |
| `httptoolkit-desktop/` | [httptoolkit/httptoolkit-desktop](https://github.com/httptoolkit/httptoolkit-desktop) | Electron oyna                        |
| npm dependency         | [httptoolkit/mockttp](https://github.com/httptoolkit/mockttp)                         | Proxy engine (HTTP/HTTPS MITM)       |

Asosiy loyiha va issue'lar: [httptoolkit/httptoolkit](https://github.com/httptoolkit/httptoolkit).
Upstream kod `git subtree --squash` orqali qo'shilgan. Ya'ni kodning hammasi shu repoda, upstream commit tarixi esa olinmagan.

## Ishga tushirish

Kerak: macOS, Node.js 24, git.

```bash
git clone https://github.com/azimxxm/httptoolkit.git ~/Documents/httptoolkit
cd ~/Documents/httptoolkit
./setup.sh   # bir marta: uchala papkada npm ci
./start.sh   # app ochiladi. Cmd+Q bosilsa, hammasi to'xtaydi
```

Finder'dan ochish: `Start HTTP Toolkit.command` faylini ikki marta bosing. Log'lar `logs/` papkada saqlanadi.

**Boshqa Mac'da davom ettirish:** `git pull` → `./setup.sh` → `./start.sh`. `setup.sh` faqat dependency'lar o'zgarganda kerak.

## Nimani qayerda o'zgartirish

| Nima                 | Qayerda                   | Qachon ko'rinadi                              |
| -------------------- | ------------------------- | --------------------------------------------- |
| Ekranlar, dizayn     | `httptoolkit-ui/src`      | darhol (hot reload)                           |
| Interceptor'lar, API | `httptoolkit-server/src`  | server o'zi qayta ishga tushadi               |
| Oyna, menu, Electron | `httptoolkit-desktop/src` | `./start.sh` qayta ishga tushirilgandan keyin |

## Telefon trafigi

Proxy Mac'da `8000`-portda ishlaydi va Wi-Fi tarmog'idan ochiq. Mac IP'sini bilish: `ipconfig getifaddr en0`.

- **iPhone:**
  1. Wi-Fi → (i) → Configure Proxy → Manual. Server: Mac IP, port: `8000`.
  2. Safari'da `http://amiusing.httptoolkit.tech/certificate` ni oching va profilni yuklab oling.
  3. Settings → General → VPN & Device Management bo'limida profilni o'rnating.
  4. Settings → General → About → Certificate Trust Settings bo'limida **HTTP Toolkit CA**ni yoqing.
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
- [ ] O'zimizning `.app`imizni yig'ish. Buning uchun:
  1. `httptoolkit-server/src/constants.ts` — o'z UI origin'imizga ruxsat berish (hozir faqat `https://app.httptoolkit.tech` ruxsat etilgan).
  2. Auto-update'ni o'chirish: `httptoolkit-server/src/index.ts` (`update-requested`) va `package.json` → `oclif.update`. Aks holda rasmiy server bizning server o'rniga yuklanib qoladi.
  3. UI build'ini (`httptoolkit-ui` → `npm run build`) app ichiga qo'shish va `APP_URL`ni unga yo'naltirish.
  4. `httptoolkit-desktop/package.json` faylida `appId`, `productName`, signing va notarize sozlamalarini o'zgartirish. `build-setup/setup-server.ts` server'ni GitHub release'dan yuklamasin, `../httptoolkit-server`dan yig'sin.
- [ ] Proxyman'dagi feature'lar:
  - **Bizda bor, lekin Pro bilan yopilgan** (`httptoolkit-ui/src/model/rules/rules.ts` → `NonPaidStepClasses`): Map Local (`file`), Map Remote (`forward-to-host`), mock, rewrite, delay, block. Breakpoint esa bepul.
  - **Qo'shish kerak:**
    - P1: Access Control (LAN'dan kim ulana olishi), macOS system proxy toggle, iOS Simulator auto-setup, telefon ulash uchun QR.
    - P2: Highlight/Comment, Diff, Network Conditions, DNS Spoofing.
    - P3: Scripting, Reverse Proxy, native Swift + SwiftNIO versiya.

## Eslatmalar

- **License:** AGPL-3.0 (`LICENSE`). App'ni boshqalarga tarqatsangiz, uning source kodi ham ochiq bo'lishi shart. Bu repo public, shuning uchun bu shart bajarilgan.
- **Xavfsizlik:** dev rejimda server token'siz ishlaydi, proxy esa butun Wi-Fi tarmog'iga ochiq. Ishonchsiz tarmoqda ishlatmang.
- Rasmiy HTTP Toolkit bilan bir xil CA'dan (`~/Library/Preferences/httptoolkit/ca.pem`) foydalanadi, shuning uchun telefonga sertifikatni bir marta o'rnatish yetarli.
- Server Node `v24.19.0`ni talab qiladi. Boshqa 24.x versiyalarda ham ishlaydi, faqat `EBADENGINE` ogohlantirishi chiqadi.
