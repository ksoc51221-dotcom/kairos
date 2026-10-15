// Renders assets/icon.png (1024²) with Electron, then `iconutil` builds assets/icon.icns. Run: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 1024, height: 1024, useContentSize: true, transparent: true, frame: false, webPreferences: { offscreen: false } });
  const html = `<body style="margin:0;background:transparent"><canvas id=c width=1024 height=1024></canvas><script>
    const c=document.getElementById('c'),x=c.getContext('2d');
    x.beginPath();x.roundRect(60,60,904,904,210);x.clip();
    const g=x.createLinearGradient(60,60,964,964);g.addColorStop(0,'#2b1b6b');g.addColorStop(.55,'#7b5cf0');g.addColorStop(1,'#22c08a');x.fillStyle=g;x.fillRect(0,0,1024,1024);
    x.strokeStyle='rgba(255,255,255,.95)';x.lineWidth=70;x.lineCap='round';
    x.beginPath();x.arc(512,512,235,0,Math.PI*2);x.stroke();
    x.fillStyle='#fff';x.beginPath();x.arc(512,512,92,0,Math.PI*2);x.fill();
    x.strokeStyle='rgba(255,255,255,.55)';x.lineWidth=46;x.beginPath();x.moveTo(512,277);x.lineTo(512,150);x.stroke();
  </script></body>`;
  await w.loadURL('data:text/html,' + encodeURIComponent(html)); await new Promise((r) => setTimeout(r, 400));
  const img = await w.webContents.capturePage(); const out = path.join(__dirname, '..', 'assets');
  fs.writeFileSync(path.join(out, 'icon.png'), img.resize({ width: 1024, height: 1024 }).toPNG());
  const set = path.join(out, 'icon.iconset'); fs.rmSync(set, { recursive: true, force: true }); fs.mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) for (const k of [1, 2]) { const px = s * k; execFileSync('sips', ['-z', px, px, path.join(out, 'icon.png'), '--out', path.join(set, `icon_${s}x${s}${k === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' }); }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(out, 'icon.icns')]); fs.rmSync(set, { recursive: true, force: true });
  console.log('icon done'); app.quit();
});
