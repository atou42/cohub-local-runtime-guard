import fs from 'node:fs';
import path from 'node:path';
const home = process.env.HOME;
const setup = JSON.parse(fs.readFileSync(path.join(home, 'fixture.json'), 'utf8'));
process.on('SIGTERM', () => {
  fs.appendFileSync(path.join(home, 'signals.jsonl'), JSON.stringify({ pid: process.pid, signal: 'SIGTERM' }) + '\n');
  if (!setup.ignoreTerm) process.exit(0);
});
fs.writeFileSync(path.join(home, `worker-ready-${process.pid}`), '');
setInterval(() => {}, 1000);
