# HTTP Toolkit — local workspace

HTTP Toolkit'ni **o'z source kodingizdan** bitta app sifatida ishga tushirish uchun workspace.
Uchta upstream repo yonma-yon clone qilingan. Shu papkadagi script'lar ularni bitta app qilib ulaydi.

## Tez boshlash

```bash
./setup.sh   # bir marta: repo'larni clone qiladi + npm ci (yangi Mac'da ham shu)
./start.sh   # app'ni ochadi. Cmd+Q yoki Ctrl+C bosilsa, hammasi to'xtaydi
```

Yoki Finder'da `Start HTTP Toolkit.command`ni ikki marta bosing.
Log'lar: `logs/server.log`, `logs/ui.log`.

## Arxitektura

```
┌──────────── httptoolkit-desktop (Electron oyna, HTK_DEV=true) ────────────┐
│  APP_URL=http://localhost:8080 ni ochadi                                  │
└───────────────┬───────────────────────────────────────────────────────────┘
                │
┌───────────────▼────────────┐  REST + WebSocket   ┌───────────────────────────────┐
│ httptoolkit-ui   :8080     │ ──────────────────► │ httptoolkit-server            │
│ React + MobX (hot reload)  │  :45457  API        │ Node.js + oclif               │
│                            │ ──────────────────► │ :45456  Mockttp admin         │
└────────────────────────────┘                     │ interceptor'lar (Android, …)  │
                                                   └───────────────┬───────────────┘
                                                                   │ boshqaradi
                    telefon / browser / terminal ──► proxy *:8000 (mockttp) ──► internet
```

| Repo                  | Vazifasi                                                                     | Stack                                               |
| --------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------- |
| `httptoolkit-ui`      | Butun interfeys va mantiq (Intercept, View, Modify, Send)                    | TypeScript, React, MobX, styled-components, webpack |
| `httptoolkit-server`  | Proxy'ni boshqaradi, interceptor'lar (Chrome, terminal, Android ADB, Frida…) | TypeScript, Node.js, oclif, mockttp                 |
| `httptoolkit-desktop` | Electron qobig'i: server'ni ishga tushiradi va UI'ni oynada ochadi           | TypeScript, Electron                                |

Rasmiy app'da desktop UI'ni `https://app.httptoolkit.tech` dan, server'ni esa GitHub release'dan oladi.
`start.sh` esa desktop'ning `HTK_DEV` rejimidan foydalanadi va ikkalasini **sizning local kodingizdan** ishlatadi.

## Nimani qayerda o'zgartirish kerak

| Nima                                 | Qayerda                                      | Qayta ishga tushirish                |
| ------------------------------------ | -------------------------------------------- | ------------------------------------ |
| Ekranlar, dizayn, yangi funksiyalar  | `httptoolkit-ui/src/components`, `src/model` | shart emas (hot reload)              |
| Qurilma yoki app ulash (interceptor) | `httptoolkit-server/src/interceptors`        | shart emas (`node --watch`)          |
| Proxy engine, rule turlari           | `mockttp` (alohida repo, npm dependency)     | —                                    |
| Oyna, menu, Electron sozlamalari     | `httptoolkit-desktop/src`                    | `./start.sh`ni qayta ishga tushiring |

## Telefon trafigini ko'rish

Proxy Mac'ning **barcha tarmoq interfeyslarida** (`*:8000`) tinglaydi, shuning uchun bitta Wi-Fi'dagi telefon unga ulana oladi.
Mac IP'sini bilish: `ipconfig getifaddr en0`. 8000-port band bo'lsa, keyingi bo'sh port olinadi. Haqiqiy portni app'dagi **Anything** kartasi ko'rsatadi.

**iPhone (Proxyman'dagi kabi):**

1. iPhone → Settings → Wi-Fi → (i) → Configure Proxy → **Manual** → Server: Mac IP, Port: `8000`.
2. Safari'da `http://amiusing.httptoolkit.tech/certificate` ni ochib, profilni yuklang.
3. Settings → General → VPN & Device Management → **HTTP Toolkit CA** → Install.
4. Settings → General → About → Certificate Trust Settings → **HTTP Toolkit CA**ni yoqing.
5. App'da **View** sahifasini oching — telefon so'rovlari shu yerda ko'rinadi.

Ish tugagach, Wi-Fi proxy'ni **Off** qiling. Aks holda app yopiq paytda telefonda internet ishlamaydi.

**Android:**

- **Android Device via QR code** — root shart emas. Telefonga HTTP Toolkit Android app'ini o'rnatasiz va QR'ni skanerlaysiz. Ba'zi app'larda HTTPS uchun qo'shimcha sozlash kerak bo'ladi.
- **Android Device via ADB** — USB orqali ulangan qurilma yoki emulator uchun. Root qilingan qurilma va emulator'ga system sertifikatini avtomatik o'rnatadi.
- **Frida** (Android root / iOS jailbreak) — ko'pchilik certificate pinning'ni o'chiradi (experimental).

## Upstream bilan sinxronlash va fork

```bash
git -C httptoolkit-ui pull   # upstream yangilanishlari (har bir repo uchun alohida)
```

GitHub'da fork qilganingizdan keyin:

```bash
cd httptoolkit-ui
git remote rename origin upstream
git remote add origin https://github.com/<siz>/httptoolkit-ui.git
```

Yangi Mac'da: `GITHUB_OWNER=<siz> ./setup.sh`.

## Keyingi bosqich: o'zingizning `.app`ingiz

`start.sh` — development rejimi. Mustaqil `.app` (Dock'da o'z nomi bilan) yig'ish uchun kodda quyidagilarni o'zgartirish kerak:

1. **Origin cheklovi** — `httptoolkit-server/src/constants.ts`. Packaged server faqat `https://app.httptoolkit.tech` UI'ni qabul qiladi. O'z UI origin'ingizni qo'shing.
2. **Auto-update** — `httptoolkit-server/src/index.ts` (`update-requested`) va `package.json` → `oclif.update`. O'chirilmasa, rasmiy server `~/.local/share/httptoolkit-server/client/` ga yuklanadi va sizning o'zgartirilgan serveringiz o'rniga ishlaydi.
3. **UI'ni app ichiga qo'shish** — desktop default holatda hosted UI'ni ochadi. `httptoolkit-ui`da `npm run build` qiling (natija `dist/` papkada). Keyin uni desktop ichidan serve qilib, `APP_URL`ni shu manzilga yo'naltiring.
4. **Desktop build** — `httptoolkit-desktop/package.json` faylida `build.appId` va `productName`ni o'zgartiring, shunda app rasmiy app bilan to'qnashmaydi. Local build uchun `mac.forceCodeSigning` va `notarize`ni o'chiring. `build-setup/setup-server.ts` server'ni GitHub release'dan yuklaydi. Uni `httptoolkit-server`da `npm run build:release` bilan o'zingiz yig'gan server bilan almashtiring.

## Eslatmalar

- **License:** AGPL-3.0. O'zingiz ishlatishingiz uchun hech qanday cheklov yo'q. App'ni boshqalarga tarqatsangiz, o'zgartirilgan source'ni ham ochiq qilishingiz shart.
- **Xavfsizlik:** dev rejimida server auth token'siz ishlaydi (rasmiy app har safar random token yaratadi). Proxy esa butun Wi-Fi'ga ochiq. Ishonchsiz tarmoqda (kafe va h.k.) ishlatmang.
- **Rasmiy app bilan birga:** rasmiy HTTP Toolkit random portlarni (28000–29999), dev rejimi esa 45456/45457 portlarini ishlatadi. Ikkalasi ham bitta CA'dan (`~/Library/Preferences/httptoolkit/ca.pem`) foydalanadi. Shuning uchun telefonga sertifikatni bir marta o'rnatish yetarli.
- **Node:** server `package.json` aniq Node `v24.19.0` ni talab qiladi. 24.14 bilan ham ishlaydi, faqat `EBADENGINE` ogohlantirishi chiqadi. Versiyani moslashtirish: `nvm install 24.19.0`.
- **Apple Silicon:** UI'dagi puppeteer 5 (faqat integration test uchun ishlatiladi) arm64 Chromium yuklay olmaydi. `setup.sh` bu yuklashni o'tkazib yuboradi, app'ga ta'siri yo'q.
- Dev rejimida Dock'da app nomi **Electron** bo'lib ko'rinadi. Bu normal holat.
