Wirepane is a free, open-source HTTP(S) debugger for developers, QA and beginners. It captures the traffic of browsers, phones, Docker and other apps, shows it, and lets you mock, rewrite, block or delay it. It also sends requests and keeps them in collections that you can share as a file (Postman or Bruno format). No account, no paid plan.

Wirepane is built on [HTTP Toolkit](https://httptoolkit.com) (AGPL-3.0) and uses packages from [Bruno](https://www.usebruno.com) (MIT). It isn't the official HTTP Toolkit and isn't affiliated with it. Wirepane is AGPL-3.0 too, and all of its source is in this repository.

## Download

| System                                          | File                                                                                                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS 12 or later, Apple Silicon (M1 and newer) | `Wirepane-{{VERSION}}-mac-arm64.pkg` (installer), or `Wirepane-{{VERSION}}-mac-arm64.zip` (the app)                                                                              |
| Windows 10 and 11, x64                          | `Wirepane-{{VERSION}}-win-x64-setup.exe` (installer), or `Wirepane-{{VERSION}}-win-x64.zip` (no install)                                                                         |
| Linux, x64                                      | `Wirepane-{{VERSION}}-linux-amd64.deb` (Debian, Ubuntu), `Wirepane-{{VERSION}}-linux-x86_64.rpm` (Fedora, RHEL), `Wirepane-{{VERSION}}-linux-x86_64.AppImage` (any distribution) |

`SHA256SUMS.txt` has the SHA-256 checksum of every file.

## Install

These builds aren't signed yet: there's no Apple Developer account or code signing certificate. So each system warns once, before the first start:

- **macOS:** open the `.pkg`. If macOS says it can't check it, right-click the file → **Open** → **Open**, or go to System Settings → Privacy & Security and click **Open Anyway**. Then follow the installer. For the `.zip`, move `Wirepane.app` to Applications and open it the same way.
- **Windows:** run the setup `.exe`. If SmartScreen says "Windows protected your PC", click **More info** → **Run anyway**. The `.zip` needs no install: unpack it and run `Wirepane.exe`.
- **Linux:** `sudo apt install ./Wirepane-{{VERSION}}-linux-amd64.deb`, or `sudo dnf install ./Wirepane-{{VERSION}}-linux-x86_64.rpm`. For the AppImage: `chmod +x Wirepane-{{VERSION}}-linux-x86_64.AppImage`, then run it. If it doesn't start on Ubuntu 24.04 or later, run it with `--no-sandbox`, or use the `.deb`.

To see HTTPS traffic, a device has to trust Wirepane's own certificate, **Wirepane CA**: the Intercept page shows how for each device.

## VPN mode (iPhone and iPad)

**Intercept** → **iPhone or iPad** → **Capture all apps (VPN)** sends everything the phone does through Wirepane, including Flutter apps, games and apps that ignore the Wi-Fi proxy. The iPhone needs the free WireGuard app: start the VPN in Wirepane, scan the QR code in WireGuard and turn the tunnel on. HTTPS still needs the Wirepane CA, and apps that pin their certificate show only the host name. Turn the tunnel off when you're done, or the iPhone has no internet while Wirepane isn't running.

On macOS 15 or later, macOS asks Wirepane for access to the local network the first time VPN mode starts. Click **Allow**: without it the iPhone may not be able to connect. VPN mode has only been tested on macOS so far, not on Windows or Linux.

## O'zbekcha

Wirepane — developerlar, QA va boshlovchilar uchun bepul HTTP(S) debugger. U [HTTP Toolkit](https://httptoolkit.com) (AGPL-3.0) va [Bruno](https://www.usebruno.com) (MIT) kodi asosida yasalgan, rasmiy HTTP Toolkit emas.

Bu build'lar hali imzolanmagan, shuning uchun birinchi ochishda ogohlantirish chiqadi:

- **macOS:** `.pkg`ni oching. macOS to'xtatsa: faylni o'ng tugma bilan bosib **Open** → **Open**, yoki System Settings → Privacy & Security → **Open Anyway**.
- **Windows:** setup `.exe`ni ishga tushiring. SmartScreen chiqsa: **More info** → **Run anyway**.
- **Linux:** `.deb` yoki `.rpm`ni o'rnating. AppImage uchun avval `chmod +x Wirepane-{{VERSION}}-linux-x86_64.AppImage`, keyin ishga tushiring.

**VPN rejimi (iPhone va iPad):** **Intercept** → **iPhone or iPad** → **Capture all apps (VPN)** telefondagi hamma ilovaning trafigini, jumladan Flutter ilovalarini ham, Wirepane orqali o'tkazadi. iPhone'da bepul WireGuard ilovasi kerak: Wirepane'da VPN'ni ishga tushiring, QR code'ni WireGuard'da skanerlang va tunnel'ni yoqing. HTTPS uchun Wirepane CA baribir kerak; sertifikatni pin qiladigan ilovalarda faqat host ko'rinadi. Ish tugagach, tunnel'ni o'chiring: aks holda Wirepane ishlamayotganda iPhone'da internet bo'lmaydi.

macOS 15 va yangiroq'da VPN rejimi birinchi marta ishga tushganda macOS Wirepane'dan lokal tarmoqqa kirish ruxsatini so'raydi. **Allow** bosing, aks holda iPhone ulana olmasligi mumkin. VPN rejimi hozircha faqat macOS'da sinalgan.
