/* 一次跑完。上線前跑這支就好:node test/all.mjs
   ★ physics 先跑:物理是這個專案的地基,它壞掉時 rules 會印一堆看不懂的紅。*/
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = [
  'physics.mjs',   // 布娃娃站得起來 / 走跳 / 掉台 / 揮拳 / 抓丟 / 煞車兩難(真的 Rapier)
  'rules.mjs',     // 場景與人物建構 / 每幀同步 / 回合比分 / AI / 視角 / HUD(headless 假 renderer)
  'smoke.mjs',     // 出貨前保險:同步驅動 30 幀,抓「上線即當」
];
const sum = { pass: 0, fail: 0 };
let bad = 0;
for (const f of FILES) {
  console.log(`\n${'═'.repeat(58)}\n▶ ${f}\n${'═'.repeat(58)}`);
  const r = spawnSync(process.execPath, [path.join(HERE, f)], { encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  if (r.stderr) process.stderr.write(r.stderr);
  const m = /(\d+) 過 \/ (\d+) 失敗/.exec(r.stdout || '');
  if (m) { sum.pass += +m[1]; sum.fail += +m[2]; }
  else { console.error(`⚠ ${f} 沒有印出計數(可能中途炸了)`); bad++; }
  if (r.status !== 0) bad++;
}
console.log(`\n${'═'.repeat(58)}`);
console.log(`總計:${sum.pass} 過 / ${sum.fail} 失敗`);
console.log(sum.fail || bad ? '🔴 有紅的,別部署' : '🟢 全綠');
process.exit(sum.fail || bad ? 1 : 0);
