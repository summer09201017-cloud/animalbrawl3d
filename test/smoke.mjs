/* 🔬 出貨前最低保險(3d-game-kit:「對線上站同步驅動 30 幀 catch 例外——
   一行就能抓到『上線即當』」)。這裡是本機版:每一種動物組合都開一場、驅動一段,
   任何一個組合會 throw 就紅。★ 這種錯最常見於「某種動物少一個設定欄位」。*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game, KIND_LIST } from '../src/game.js';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  🟢 ' + n)) : (fail++, console.log('  🔴 ' + n + (x ? ' → ' + x : ''))); };

for (const k of KIND_LIST) {
  let err = null, frames = 0;
  try {
    const g = new Game({}, { headless: true });
    await g.init({ kinds: [k, k], ai: [true, true], winScore: 9, arenaRadius: 4 });
    for (let i = 0; i < 240; i++) { g.update(1 / 60); g.render(); frames++; }
    /* 每一種動物都要真的畫得出東西、而且位置是有限數 */
    const p = g.W.animals[0].parts.pelvis.translation();
    if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) err = 'NaN 座標';
    if (g.renderer._n !== frames) err = `render 次數對不上(${g.renderer._n}/${frames})`;
  } catch (e) { err = e.message; }
  ok(`同種對打 ${k} × 2:驅動 240 幀不爆`, err === null, err || '');
}
/* 混搭也要過(設定欄位缺一個的話,這裡會抓到) */
for (const [a, b] of [['cat', 'duck'], ['bunny', 'dog'], ['duck', 'bunny']]) {
  let err = null;
  try {
    const g = new Game({}, { headless: true });
    await g.init({ kinds: [a, b], ai: [true, true], winScore: 9 });
    for (let i = 0; i < 180; i++) { g.update(1 / 60); g.render(); }
  } catch (e) { err = e.message; }
  ok(`混搭 ${a} vs ${b}`, err === null, err || '');
}
/* ══════════ PWA 殼層檔的位置 ══════════
   ⚠⚠ 首次 build 就踩到:sw.js / icon.svg / manifest.webmanifest 放在 repo 根目錄
     ⇒ **vite 只會複製 public/ 裡的東西** ⇒ 三個檔一個都沒進 dist。
     後果最陰:本機 dev 一切正常(dev server 會服務根目錄),**上線後 SW 與圖示 404**
     ⇒ 裝不到主畫面、離線打不開,而首頁看起來完全正常、遊戲也玩得動。
   ★ 這一段釘的是**病根(檔案放在哪)**而不是症狀(dist 少檔)——
     病根不必先 build 就驗得到,所以它每次都會跑。*/
console.log('\n── PWA 殼層檔要放在 public/(vite 只複製那裡) ──');
for (const f of ['sw.js', 'icon.svg', 'manifest.webmanifest']) {
  const inPublic = fs.existsSync(path.join(ROOT, 'public', f));
  const inRoot = fs.existsSync(path.join(ROOT, f));
  ok(`${f} 在 public/(不是放在 repo 根目錄)`, inPublic && !inRoot,
    inRoot ? '🔴 它在根目錄 ⇒ 不會進 dist ⇒ 線上 404' : '不在 public/');
}
/* build 過了就順手驗 dist;沒 build 過就跳過(不要因為還沒 build 就變紅)*/
const dist = path.join(ROOT, 'dist');
if (fs.existsSync(dist)) {
  for (const f of ['index.html', 'sw.js', 'icon.svg', 'manifest.webmanifest']) {
    ok(`dist/${f} 存在`, fs.existsSync(path.join(dist, f)));
  }
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  ok('★ dist/index.html 指到打包後的 JS(不是還指著 src/main.js)',
    /assets\/index-[\w-]+\.js/.test(html) && !/src\/main\.js/.test(html));
} else {
  console.log('  ⏭ 還沒 build 過,dist 那幾項跳過(npm run build 之後會驗)');
}

console.log(`\n🔬 smoke:${pass} 過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
