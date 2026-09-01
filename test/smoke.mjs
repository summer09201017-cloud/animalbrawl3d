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
/* ══════════ ★ 架構分界線:物理層不准碰渲染層 ══════════
   這一條是「那 50 項物理測試為什麼算數」的**唯一前提**:
   physics.js 不碰 three/DOM ⇒ node 裡 import 得進來 ⇒ 測試驅動的是**真的 Rapier**。
   一旦破線,node 一載入就炸,而人在那個時候最順手的修法是加一句
   「沒有 renderer 就 return」—— 於是測試照樣印全綠,卻一個數字都沒算(靜默失效)。
   ⚠⚠ 在補上這一段之前,這條規矩**只寫在 physics.js 的註解裡**:破線不會有任何東西變紅。
      註解攔不住人,測試才攔得住。*/
console.log('\n── ★ 架構分界線:src/physics.js 不准 import three ──');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
const physSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'physics.js'), 'utf8'));
const gameSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'game.js'), 'utf8'));
const importsThree = (s) => /\bfrom\s*['"]three['"]|\brequire\(\s*['"]three['"]\s*\)|\bimport\(\s*['"]three['"]\s*\)/.test(s);
ok('★ src/physics.js 沒有 import three(破線 = 物理測試靜默失效)', !importsThree(physSrc),
  '物理層一旦碰 three,headless 就驅動不了真物理');
/* ★ 上面那條的**保險絲**:證明這支判準真的抓得到一個 import。
   少了這一條,判準本身寫錯(regex 打錯字、檔名改了)會永遠綠 ——
   而我們會以為分界線有人守著。同 mutation-first-testing:
   「把修法停掉,它會不會變紅?」這裡是「拿一個真的有 import 的檔餵它,它會不會抓到?」*/
ok('   判準有效性:同一支判準在 game.js 上抓得到 three', importsThree(gameSrc),
  '判準抓不到已知的 import ⇒ 上面那條綠燈是假的');
/* 物理層也不准碰 DOM:node 裡沒有這些東西,一碰就逼出同一種「早退保命」的修法 */
for (const g of ['document', 'window', 'requestAnimationFrame']) {
  ok(`src/physics.js 沒有用到 ${g}(node 裡沒有這些)`, !new RegExp(`\\b${g}\\b`).test(physSrc));
}

/* ══════════ ★ 「用空字串還原 display」的回落陷阱 ══════════
   0901 真瀏覽器驗收抓到兩個:`#hud` 與 `#again` 在 CSS 裡的預設是 `display:none`,
   而 main.js 把 display 指派成**空字串**(= 清掉 inline 樣式)想「恢復顯示」——
   清掉之後回落到 CSS 的 none ⇒ **HUD 整組不顯示、比賽結束的鈕永遠不出現**。
   ⚠ 為什麼 headless 全綠:測試讀的是 `game.hud()` 那個**物件**,而那個物件永遠是對的;
     錯的是「畫面上看不看得見」。連 getComputedStyle 拿字級也照樣拿得到值
     (祖先 display:none 不影響 font-size)⇒ 假綠燈。只有截圖/真的點它才會現形。
   ⇒ 這一段用**靜態比對**釘住病根:CSS 裡藏起來的 id,JS 不准用空字串去顯示它。
   ★ 全域也有同族 hook(css-hidden-toggle-guard #25,尋羊記「帶回這隻羊」鈕的血案),
     但那支只在「AI 動到檔案」時才響 —— repo 內的測試每次 npm test 都會跑,兩層互補。*/
console.log('\n── ★ CSS 藏起來的元素,不准用空字串去顯示 ──');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const mainJs = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  // CSS 裡「#id{ … display:none … }」的 id 清單(只看單一 id 選擇器的規則)
  const noneIds = new Set();
  for (const m of html.matchAll(/#([\w-]+)\s*\{([^}]*)\}/g)) {
    if (/display\s*:\s*none/.test(m[2])) noneIds.add(m[1]);
  }
  // JS 裡把某個 id 的 display 指派成空字串的地方(含三元運算的兩側)
  const EMPTY = String.raw`(?:''|""|` + '``' + `)`;
  const reDirect = new RegExp(String.raw`\$\(\s*['"]([\w-]+)['"]\s*\)\s*\.style\.display\s*=\s*` + EMPTY, 'g');
  const reTernary = new RegExp(String.raw`\$\(\s*['"]([\w-]+)['"]\s*\)\s*\.style\.display\s*=[^;\n]*?[?:]\s*` + EMPTY, 'g');
  const emptied = new Set();
  for (const m of mainJs.matchAll(reDirect)) emptied.add(m[1]);
  for (const m of mainJs.matchAll(reTernary)) emptied.add(m[1]);
  const bad = [...emptied].filter((id) => noneIds.has(id));
  ok('★ 沒有「CSS 藏起來、JS 用空字串想顯示」的元素', bad.length === 0,
    bad.length ? `🔴 ${bad.map((b) => '#' + b).join(', ')} ⇒ 畫面上永遠看不到` : `CSS 藏起來的:${[...noneIds].map((i) => '#' + i).join(',') || '(無)'}`);
  /* 判準有效性保險絲:確定這支判準的「CSS 那一側」真的抓得到已知的兩個 */
  ok('   判準有效性:抓得到 #hud/#again 在 CSS 是 display:none', noneIds.has('hud') && noneIds.has('again'),
    `抓到 ${[...noneIds].join(',')}`);
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
