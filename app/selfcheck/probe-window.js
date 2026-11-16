// Probe: can Electron open a real window and capture pixels on this machine?
// Writes a PNG and prints one PROBE line. Run under a display (or Xvfb).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const out = process.env.PROBE_OUT || path.join(__dirname, 'probe.png');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 900,
      height: 620,
      show: false,
      webPreferences: { offscreen: false, sandbox: false },
    });
    await win.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          '<body style="margin:0;background:#0f1115;color:#e6edf3;font:14px monospace">' +
            '<h1 style="padding:24px">probe ok</h1></body>'
        )
    );
    await new Promise((r) => setTimeout(r, 250));
    const img = await win.webContents.capturePage();
    const png = img.toPNG();
    fs.writeFileSync(out, png);
    const size = img.getSize();
    console.log(`PROBE ok bytes=${png.length} size=${size.width}x${size.height} display=${process.env.DISPLAY || 'none'}`);
    app.exit(0);
  } catch (err) {
    console.log('PROBE fail ' + (err && err.message));
    app.exit(1);
  }
});
