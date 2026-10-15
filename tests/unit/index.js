// Makes `node --test tests/unit` work on Node 22+, which treats that argument as a file rather than a folder.
// Each *.test.js runs in its own process (the store and the server are singletons), then this entry reports the combined result.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(__dirname, f));
const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; // the inner run is a normal run, not a child of the outer one
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
