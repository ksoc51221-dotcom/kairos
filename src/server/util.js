// Small helpers shared by the route modules.
const path = require('path');
const os = require('os');

const pub = path.join(__dirname, 'public');
const page = (file) => (_q, res) => res.sendFile(path.join(pub, file));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const lanIp = () => Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

module.exports = { pub, page, esc, lanIp };
