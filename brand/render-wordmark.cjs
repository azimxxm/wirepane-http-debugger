// Renders an HTML file to a transparent PNG with Electron's Chromium, so the wordmark
// gets the same DM Sans font the UI uses.
// Usage: electron render-wordmark.cjs <page.html> <out.png> <width> <height>
const { app, BrowserWindow } = require("electron");
const fs = require("fs");

const [htmlPath, outPath, width, height] = process.argv.slice(2);

// Without this a Retina screen would give a 2x image
app.commandLine.appendSwitch("force-device-scale-factor", "1");

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: Number(width),
      height: Number(height),
      useContentSize: true,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: { offscreen: true },
    });
    await win.loadFile(htmlPath);
    await win.webContents.executeJavaScript(
      "document.fonts.ready.then(() => true)",
    );
    // Give the offscreen renderer a moment to paint the loaded font and image
    await new Promise((resolve) => setTimeout(resolve, 300));

    const image = await win.webContents.capturePage();
    fs.writeFileSync(outPath, image.toPNG());
    app.exit(0);
  } catch (error) {
    console.error("Wordmark render failed:", error);
    app.exit(1);
  }
});
