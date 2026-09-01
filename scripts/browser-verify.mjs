#!/usr/bin/env node
/* ===========================================================================
 * 瀏覽器實機驗收(roadmap 第 1 列)
 * ---------------------------------------------------------------------------
 * 為什麼要有這一支:`node test/all.mjs` 那 112 項跑的是**假 renderer**,
 * 它證明「不丟執行期錯、物理數字對」,但證明不了:
 *   真 WebGL 畫不畫得出來 / 鏡頭有沒有 NaN 中毒 / 框不框得住兩隻 /
 *   按右到底是往畫面右走還是往左走 / 拳頭打不打得到 / 結算卡出不出來。
 * 那些只有真瀏覽器 + 眼睛看得出來。截圖存 .shots/(不入庫)。
 *
 * 跑法:  npm run dev            # 另一個視窗
 *         node scripts/browser-verify.mjs
 *         URL=http://localhost:4173/ node scripts/browser-verify.mjs   # 驗 build 後
 *         HEADED=1 node scripts/browser-verify.mjs                     # 想自己看
 *
 * ★ 驗法本身的三條鐵則(canvas-playwright-verify 血淚,別拿掉):
 *   1. 等「遊戲時間真的推進」,不要 waitForTimeout —— 無頭 Chromium 沒 GPU,
 *      rAF 是成串爆發的,固定等待期間 W.t 可能一動都沒動 ⇒ 假紅。
 *   2. 真的按鍵盤/點滑鼠,不要 evaluate 直接呼叫函式 —— 那樣繞過命中判定與輸入管線。
 *   3. 等「畫過一幀的物證」(W.t > 0),不要只等 state === 'fight'(旗標在 boot 就成立)。
 * =========================================================================== */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const URL = process.env.URL || 'http://localhost:5173/';
const OUT = process.env.SHOTS || '.shots';
const HEADED = process.env.HEADED === '1';

mkdirSync(OUT, { recursive: true });

const checks = [];
const errors = [];
const ok = (name, pass, detail = '') => {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? '🟢' : '🔴'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const note = (s) => console.log(`     · ${s}`);

const browser = await chromium.launch({
  headless: !HEADED,
  // 無頭沒有顯卡 ⇒ 要 swiftshader 才有 WebGL,不然 three 建不出 renderer
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });

let shotN = 0;
const shots = [];
async function shot(name) {
  const file = join(OUT, `${String(++shotN).padStart(2, '0')}-${name}.png`);
  const buf = await page.screenshot({ path: file, type: 'png' });
  shots.push({ file, kb: +(buf.length / 1024).toFixed(1) });
  note(`📸 ${file}  ${(buf.length / 1024).toFixed(0)} KB`);
  return buf.length;
}

/** 遊戲時間推進 s 秒(不是牆上時間)。無頭 rAF 成串爆發 ⇒ 只有這個等法可靠。 */
async function advance(s) {
  const t0 = await page.evaluate(() => window.__brawl.W.t);
  await page.waitForFunction(
    (want) => (window.__brawl.W.t >= want ? { t: window.__brawl.W.t } : null),
    t0 + s, { timeout: 60000, polling: 60 },
  );
}
/** 按住某鍵讓遊戲跑 s 秒(真鍵盤事件),回傳期間位移與 NDC 變化 */
async function holdFor(code, s) {
  const before = await page.evaluate(() => ({ w: window.__chest(0), n: window.__proj0() }));
  await page.keyboard.down(code);
  await advance(s);
  await page.keyboard.up(code);
  const after = await page.evaluate(() => ({ w: window.__chest(0), n: window.__proj0() }));
  return { before, after };
}
/** 量一個方向鍵:按過去、再按回來抵銷,免得驗到後面自己走下台。
 *  ⚠⚠ 第一版就是漏了「按回來」:台子半徑 3.6,四個視角各按 D 0.75 秒(每次走 1.5~1.8 m)
 *     ⇒ 一號自己走進虛空(髖部 y=-245 m),之後「跳不起來/出不了拳/框不住」全部變紅。
 *     那 6 條紅燈**沒有一條是產品的錯**,全是驗法把角色推下台。
 *     ⇒ 同 canvas-playwright-verify:紅了先問「是不是我的驗法」。 */
async function measureKey(code, back, s = 0.5) {
  const run = await holdFor(code, s);
  await page.keyboard.down(back); await advance(s * 1.05); await page.keyboard.up(back);
  await advance(0.25);
  const cam = await page.evaluate(() => window.__camFwd());
  const wx = run.after.w.x - run.before.w.x, wz = run.after.w.z - run.before.w.z;
  const m = Math.hypot(wx, wz);
  return {
    dx: run.after.n.x - run.before.n.x,
    dy: run.after.n.y - run.before.n.y,
    m,
    fwd: m > 1e-4 ? (wx * cam.x + wz * cam.z) / m : 0,   // 位移方向 vs「鏡頭前方」的餘弦
  };
}
/** 按住前進鍵,**逐小段**比對「這一段的位移」與「這一段當下的鏡頭前方」,回傳中位數。
 *  會轉的鏡頭(跟隨視角)只有這樣量才有意義 —— 見 view 迴圈裡那條註解。*/
async function measureForward(code, back, s = 0.6, n = 6) {
  const seg = s / n;
  const samples = [];
  let x0 = await page.evaluate(() => ({ p: window.__chest(0), f: window.__camFwd() }));
  await page.keyboard.down(code);
  let total = 0;
  for (let i = 0; i < n; i++) {
    await advance(seg);
    const x1 = await page.evaluate(() => ({ p: window.__chest(0), f: window.__camFwd() }));
    const dx = x1.p.x - x0.p.x, dz = x1.p.z - x0.p.z;
    const m = Math.hypot(dx, dz);
    total += m;
    if (m > 0.01) samples.push((dx * x0.f.x + dz * x0.f.z) / m);   // 用**這一段開始時**的鏡頭方向
    x0 = x1;
  }
  await page.keyboard.up(code);
  await page.keyboard.down(back); await advance(s * 1.05); await page.keyboard.up(back);
  await advance(0.25);
  const sorted = [...samples].sort((a, b) => a - b);
  return { median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0, samples, m: total };
}

/** 驗收前確認一號**真的站在台面上**;不是就重開一場(不然後面全是假紅)
 *  ⚠⚠ 門檻踩過一次:第一版寫 `y > -1`,而站姿髖部是 **0.64 m** ——
 *     角色已經掉到 y=-0.58(台面以下、正在往虛空掉)還被判「活著」,
 *     於是「按 F 跳起來」量到 -0.584 → -0.584 = 假紅。
 *     ⇒ 門檻要對著**真實站姿**訂,不要對著「還沒掉到很遠」訂。*/
const STAND_Y = 0.35;          // 站姿髖部 ~0.64;蹲低/被打趴也在 0.35 以上
async function ensureAlive(where) {
  const st = await page.evaluate(() => {
    const g = window.__brawl, a = g.W.animals[0], p = a.parts.pelvis.translation();
    return { y: p.y, r: Math.hypot(p.x, p.z), radius: g.cfg.arenaRadius, fell: a.fellAt != null, state: g.state };
  });
  if (st.y > STAND_Y && st.r < st.radius && !st.fell && st.state === 'fight') return true;
  note(`⚠ ${where}:一號不在台面上(髖部 y=${st.y.toFixed(2)}、離心 ${st.r.toFixed(2)}/${st.radius}, state=${st.state})⇒ 重開一場再驗`);
  await page.evaluate(() => window.__brawl.restart());
  // 主動布娃娃重生後要花一點時間「站起來」,等它站直再回去驗
  await page.waitForFunction((minY) => (window.__pelvisY(0) > minY ? { y: window.__pelvisY(0) } : null), STAND_Y,
    { timeout: 20000, polling: 60 }).catch(() => { });
  await advance(0.6);
  return false;
}

console.log(`\n🌐 ${URL}\n`);
await page.goto(URL, { waitUntil: 'domcontentloaded' });

/* ── 1. 選單 ─────────────────────────────────────────────────────────── */
console.log('── 選單 ──');
await page.waitForSelector('#go', { timeout: 20000 });
const menu = await page.evaluate(() => ({
  h1: document.querySelector('#menu h1')?.textContent?.trim(),
  rows: document.querySelectorAll('#menu .row').length,
  keys: document.querySelector('#menu .keys')?.textContent?.replace(/\s+/g, ' ').trim(),
  goSize: (() => { const r = document.querySelector('#go').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
  verTag: /v\d/.test(document.querySelector('#menu')?.textContent || ''),
}));
ok('選單標題出得來', menu.h1?.includes('毛毛大亂鬥'), menu.h1);
ok('四個設定列都在(角色×2/幾分/台子)', menu.rows === 4, `${menu.rows} 列`);
ok('鍵位印在畫面上(兩個孩子搶鍵盤時不會有人去讀 README)', /WASD/.test(menu.keys) && /方向鍵/.test(menu.keys));
ok('開始鈕觸控目標 ≥44px', menu.goSize[1] >= 44, `${menu.goSize[0]}×${menu.goSize[1]}`);
ok('選單有版本號/新增功能簡歷(game-must-haves ⑦)', menu.verTag, menu.verTag ? '' : '選單看不到版本號');
await shot('menu');

/* 兩分獲勝 ⇒ 一輪就驗得到「回合結算」與「比賽結束」兩個畫面。
   ★ 台子用**大的**(6.5):驗輸入方向要走上好幾公尺,小台子會讓驗收自己把角色走下台
     (第一版就是這樣製造出 6 條假紅)。掉台改用明示的外力推,不靠小台子。 */
await page.selectOption('#ws', '2');
await page.selectOption('#ar', '6.5');

/* ── 2. 真的開一場(真滑鼠點)───────────────────────────────────────── */
console.log('\n── 開一場 ──');
await page.click('#go');
// ★ 等「物理真的跑了」的物證,不是等 state 旗標
await page.waitForFunction(() => (window.__brawl?.W?.t > 0.5 ? { t: window.__brawl.W.t } : null), null, { timeout: 60000, polling: 60 });
ok('真 WebGL 建得起來、遊戲跑得動', true, `W.t=${(await page.evaluate(() => window.__brawl.W.t)).toFixed(2)}s`);

/* 探針:世界→畫面投影、事件錄影機。★ 只在驗收腳本注入,產品碼不含這些。 */
await page.evaluate(() => {
  const g = window.__brawl;
  window.__chest = (i) => { const t = g.W.animals[i].parts.chest.translation(); return { x: t.x, y: t.y, z: t.z }; };
  window.__pelvisY = (i) => g.W.animals[i].parts.pelvis.translation().y;
  window.__alive = () => g.W.animals.filter((a) => a.fellAt == null).length;
  /* 用鏡頭自己的矩陣把世界點投到 NDC(頁面裡沒有 THREE 全域,所以手算 4x4) */
  window.__proj = (x, y, z) => {
    const cam = g.camera, P = cam.projectionMatrix.elements, V = cam.matrixWorldInverse.elements;
    const t = [], c = [];
    for (let r = 0; r < 4; r++) t[r] = V[r] * x + V[4 + r] * y + V[8 + r] * z + V[12 + r];
    for (let r = 0; r < 4; r++) c[r] = P[r] * t[0] + P[4 + r] * t[1] + P[8 + r] * t[2] + P[12 + r] * t[3];
    if (!c[3]) return null;
    return { x: c[0] / c[3], y: c[1] / c[3] };
  };
  window.__proj0 = () => { const p = window.__chest(0); return window.__proj(p.x, p.y, p.z); };
  window.__camOK = () => { const p = g.camera.position; return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z); };
  /* 鏡頭的水平前方向(matrixWorld 的第三欄取負 = three 的 forward)*/
  window.__camFwd = () => {
    const m = g.camera.matrixWorld.elements;
    const fx = -m[8], fz = -m[10], l = Math.hypot(fx, fz) || 1;
    return { x: fx / l, z: fz / l };
  };
  /* 「看不看得見」而不是「資料對不對」—— 祖先 display:none 時 getComputedStyle
     照樣拿得到字級,所以驗字級會是**假綠燈**(0901 我自己踩了這一條)。*/
  window.__seen = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false, hidden: true };
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return {
      found: true, w: Math.round(r.width), h: Math.round(r.height), display: cs.display,
      hidden: r.width === 0 || r.height === 0 || cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0,
    };
  };
  window.__ev = [];
  const orig = g.onEvent.bind(g);
  g.onEvent = (e) => { window.__ev.push({ ...e, t: g.W.t }); orig(e); };
});
await advance(0.6);
await shot('fight-start');

const hud0 = await page.evaluate(() => ({
  ...window.__brawl.hud(),
  nmPx: parseFloat(getComputedStyle(document.querySelector('.pl .nm')).fontSize),
  scPx: parseFloat(getComputedStyle(document.querySelector('.pl .sc')).fontSize),
  msgPx: (() => { const el = document.querySelector('.msg'); return el ? parseFloat(getComputedStyle(el).fontSize) : 0; })(),
}));
ok('HUD 資料齊(hud() 這個物件對不對)', hud0.players?.length === 2, hud0.players?.map((p) => `${p.label}/${p.kind}${p.ai ? '(電腦)' : ''}`).join(' vs '));
ok('回合訊息字串有產生', /第 1 回合/.test(hud0.msg || ''), hud0.msg);
note(`HUD 字級:名字 ${hud0.nmPx}px / 比分 ${hud0.scPx}px / 中央訊息 ${hud0.msgPx}px(投影後排可讀性參考)`);

/* ★★ 上面三條全綠也**不代表螢幕上看得到** —— 那是我自己在 0901 踩的假綠燈:
   `#hud` 在 CSS 是 display:none,main.js 用空字串「還原」⇒ 整組 HUD 隱形,
   而 hud() 的物件、getComputedStyle 的字級全都照樣正確。只有量「看不看得見」才抓得到。*/
const vis = await page.evaluate(() => ({
  hud: window.__seen('#hud'), bar: window.__seen('.hudbar'),
  card: window.__seen('.pl'), msg: window.__seen('.msg'), vw: window.__seen('.vw'),
}));
ok('★ HUD 真的看得見(不是只有資料對)', !vis.hud.hidden && !vis.bar.hidden && !vis.card.hidden,
  `#hud display=${vis.hud.display} ${vis.hud.w}×${vis.hud.h}・比分卡 ${vis.card.w}×${vis.card.h}`);
ok('★ 中央回合訊息真的看得見', !vis.msg.hidden, `${vis.msg.w}×${vis.msg.h}`);
ok('★ 左下角視角提示真的看得見', !vis.vw.hidden, `${vis.vw.w}×${vis.vw.h}`);

/* ── 3. 「按右往畫面右走」——四個視角都要成立 ────────────────────────
   sheepflock3d 0826 血案:固定機位下角色朝鏡頭走來時,他的右手邊在畫面上是左邊。
   ⇒ 驗的不是世界座標,是**畫面座標(NDC)**。
   隔離:先把電腦對手停掉(不然位移是被推的,不是自己走的)。 */
console.log('\n── 按右是不是往畫面右走(四視角)──');
await page.evaluate(() => { window.__brawl.cfg.ai[1] = false; });
await advance(0.4);

const VIEW_NAMES = ['固定機位', '側面轉播', '高空俯瞰', '跟隨'];
for (let v = 0; v < 4; v++) {
  const idx = await page.evaluate(() => window.__brawl.viewIdx);
  const name = VIEW_NAMES[idx];
  await advance(1.3);                                    // 等鏡頭 lerp 收斂(觀感截圖,可以等時間)
  const camOK = await page.evaluate(() => window.__camOK());
  ok(`${name}:鏡頭座標沒有 NaN`, camOK);
  const framed = await page.evaluate(() => {
    const out = [];
    for (let i = 0; i < 2; i++) { const p = window.__chest(i); out.push(window.__proj(p.x, p.y, p.z)); }
    return out;
  });
  const inFrame = framed.every((p) => p && Math.abs(p.x) <= 1.05 && Math.abs(p.y) <= 1.05);
  ok(`${name}:兩隻都框得住`, inFrame, framed.map((p) => p ? `(${p.x.toFixed(2)},${p.y.toFixed(2)})` : 'null').join(' '));

  await ensureAlive(`${name} 量測前`);
  /* 驗的是**方向(正負號)**,不是幅度:高空俯瞰在 14 公尺上方,
     走 0.42 公尺在畫面上只有 +0.004 —— 拿固定幅度門檻(0.01)去卡它會假紅。
     ⇒ 條件寫成「真的走了一段(≥0.2 m)且畫面往右」。*/
  const rt = await measureKey('KeyD', 'KeyA');
  ok(`${name}:按 D 真的往畫面右移`, rt.m >= 0.2 && rt.dx > 0,
    `畫面 x ${rt.dx >= 0 ? '+' : ''}${rt.dx.toFixed(4)}・世界位移 ${rt.m.toFixed(2)}m`);
  /* ★★ 會轉的鏡頭要**逐幀**比,不能「動完再取一次鏡頭方向」:
       跟隨視角的鏡頭黏在角色背後,角色一轉身鏡頭就繞過去(還有 0.3 秒的 lerp 落後)。
       同一段驗收碼第一輪量到 +1.00、第二輪 -0.97 —— 不是遊戲壞了,是我在拿
       「動作結束後的鏡頭方向」去比「整段位移」。⇒ 每小段各自比,取中位數。*/
  /* ★ 左右用「畫面座標」驗,前後用「鏡頭前方」驗 —— 這不是放水,是這兩件事本來就不同:
       跟隨視角的鏡頭是黏在角色背後的,角色往前走時**鏡頭跟著走**,
       所以「往前」在畫面上幾乎不動(是世界往後退)⇒ 拿畫面 y 去驗前後,
       在跟隨視角必然假紅(第一版就紅在這裡,我差點去改產品)。
       使用者真正在意的那句話是「按 W 會往我看的方向走」= 與鏡頭前方同向。*/
  const fw = await measureForward('KeyW', 'KeyS');
  ok(`${name}:按 W 真的往鏡頭前方走`, fw.median > 0.3,
    `逐幀餘弦中位數 ${fw.median.toFixed(2)}(${fw.samples.map((v) => v.toFixed(2)).join(' ')})・總位移 ${fw.m.toFixed(2)}m`);

  await shot(`view-${idx}-${['fixed', 'side', 'top', 'chase'][idx]}`);
  await page.keyboard.press('KeyV');
  await page.waitForFunction((prev) => (window.__brawl.viewIdx !== prev ? { v: window.__brawl.viewIdx } : null), idx, { timeout: 10000, polling: 60 });
}
ok('V 鍵繞完四個視角回到原點', (await page.evaluate(() => window.__brawl.viewIdx)) === 0);

/* ── 4. 手感:跳得起來 / 拳頭打得到 ─────────────────────────────────── */
console.log('\n── 手感 ──');
for (let i = 0; i < 3 && !(await ensureAlive('手感段')); i++) { /* 站穩了才量跳躍 */ }
await advance(0.5);
const standY = await page.evaluate(() => window.__pelvisY(0));
await page.keyboard.press('KeyF');
let peak = standY;
for (let i = 0; i < 8; i++) { await advance(0.09); peak = Math.max(peak, await page.evaluate(() => window.__pelvisY(0))); }
ok('按 F 真的跳起來', peak - standY > 0.12, `髖部 ${standY.toFixed(3)} → 最高 ${peak.toFixed(3)} m(+${(peak - standY).toFixed(3)})`);

/* 走過去打人:AI 恢復,靠近到 1 公尺內再連續出拳(拳是持續施力,要按著打)
   ★ 事件用「起點索引」切,不要 `__ev.length = 0` 清掉 ——
     第一版清過之後,後面「有沒有 fall 事件」那條就永遠看不到早先發生的掉台 ⇒ 假紅。*/
const evFrom = await page.evaluate(() => { window.__brawl.cfg.ai[1] = true; return window.__ev.length; });
for (let round = 0; round < 26; round++) {
  const d = await page.evaluate(() => {
    const a = window.__chest(0), b = window.__chest(1);
    return Math.hypot(a.x - b.x, a.z - b.z);
  });
  if (d > 1.05) {
    // 朝對手走:用真鍵盤,方向靠鏡頭相對輸入(所以只要往畫面上/左右修正)
    const rel = await page.evaluate(() => {
      const a = window.__chest(0), b = window.__chest(1);
      const pa = window.__proj(a.x, a.y, a.z), pb = window.__proj(b.x, b.y, b.z);
      return { dx: pb.x - pa.x, dy: pb.y - pa.y };
    });
    const keys = [];
    if (Math.abs(rel.dx) > 0.03) keys.push(rel.dx > 0 ? 'KeyD' : 'KeyA');
    if (Math.abs(rel.dy) > 0.03) keys.push(rel.dy > 0 ? 'KeyW' : 'KeyS');
    for (const k of keys) await page.keyboard.down(k);
    await advance(0.35);
    for (const k of keys) await page.keyboard.up(k);
  } else {
    await page.keyboard.press('KeyG');
    await advance(0.3);
  }
  const hits = await page.evaluate((from) => window.__ev.slice(from).filter((e) => e.type === 'hit').length, evFrom);
  if (hits >= 1) break;
  await ensureAlive('纏鬥中');   // 掉台就重開繼續打(第一版在這裡 break,只揮了 1 拳就判「打不到」= 假紅)
}
const ev = await page.evaluate((from) => window.__ev.slice(from).map((e) => e.type), evFrom);
ok('出拳有揮出去(swing)', ev.includes('swing'), `${ev.filter((t) => t === 'swing').length} 次`);
ok('★ 拳頭真的打到人(hit)', ev.includes('hit'), `${ev.filter((t) => t === 'hit').length} 次・事件流 ${[...new Set(ev)].join(',')}`);
await shot('brawl');

/* ── 5. 掉台 → 回合結算 → 比賽結束 → 再來一場 ───────────────────────── */
console.log('\n── 掉台與結算 ──');
/* ★ 這一段要驗的是「掉台 → 結算 → 換回合 → 比賽結束」這條**鏈**,
   不是「AI 打不打得贏」。所以先重開一場乾淨的,再用明示的外力把**對手**推下去 ——
   那道力就是 test G2 的 60 N·s(「站得穩但推得動」的那個數字),不是為了讓驗收好過而編的。
   ⚠ 不用「等自然纏鬥掉台」:大台子上要等很久,而且誰先掉是隨機的 ⇒ flaky。*/
await page.evaluate(() => window.__brawl.restart());
await advance(1.2);
const evFall = await page.evaluate(() => window.__ev.length);
async function shoveFoe(why) {
  note(`${why} ⇒ 對二號施一道 60 N·s 側推(與 test G2 同一道力)`);
  await page.evaluate(() => {
    const foe = window.__brawl.W.animals[1];
    for (const k of ['chest', 'pelvis']) foe.parts[k].applyImpulse({ x: 60, y: 6, z: 0 }, true);
  });
}
let sawRoundEnd = false;
for (let tryN = 0; tryN < 6 && !sawRoundEnd; tryN++) {
  await shoveFoe(`第 ${tryN + 1} 次`);
  sawRoundEnd = await page.waitForFunction(
    () => (window.__brawl.state !== 'fight' ? { s: window.__brawl.state } : null),
    null, { timeout: 15000, polling: 100 },
  ).then(() => true).catch(() => false);
}
const afterFall = await page.evaluate((from) => ({ state: window.__brawl.state, ...window.__brawl.hud(), ev: window.__ev.slice(from).map((e) => e.type) }), evFall);
ok('有人掉下台就結算(fall 事件 + 換狀態)', afterFall.ev.includes('fall') && afterFall.state !== 'fight', `state=${afterFall.state}・${afterFall.msg}`);
ok('結算訊息看得到', !!afterFall.msg, afterFall.msg);
ok('比分有跳', afterFall.players.some((p) => p.score > 0), afterFall.players.map((p) => `${p.label} ${p.score}`).join(' / '));
await shot('round-end');

/* 打到比賽結束(2 分制)—— 先等它自己開下一回合,再推第二分 */
const nextRound = await page.waitForFunction(
  () => (window.__brawl.state === 'fight' ? { r: window.__brawl.round } : null), null, { timeout: 20000, polling: 100 },
).then((h) => h.jsonValue()).catch(() => null);
ok('掉台後會自己開下一回合', !!nextRound, nextRound ? `進到第 ${nextRound.r} 回合` : '卡在結算沒有下一回合');
let matchOver = false;
for (let tryN = 0; tryN < 8 && !matchOver; tryN++) {
  const st = await page.evaluate(() => window.__brawl.state);
  if (st === 'matchEnd') { matchOver = true; break; }
  if (st === 'fight') await shoveFoe(`收第二分・第 ${tryN + 1} 次`);
  matchOver = await page.waitForFunction(
    () => (window.__brawl.state === 'matchEnd' ? { s: 1 } : null), null, { timeout: 12000, polling: 100 },
  ).then(() => true).catch(() => false);
}
const matchState = await page.evaluate(() => window.__brawl.state);
ok('打得完一場(matchEnd)', matchState === 'matchEnd', `state=${matchState}`);
const againVisible = await page.evaluate(() => {
  const b = document.getElementById('again');
  const r = b.getBoundingClientRect();
  return { shown: getComputedStyle(b).display !== 'none', h: Math.round(r.height) };
});
ok('「再來一場」鈕在比賽結束時出現', againVisible.shown, `高 ${againVisible.h}px`);
ok('返回大廳鈕(game-must-haves ④)', await page.evaluate(() => /大廳|返回/.test(document.body.innerText)), '結算畫面找不到返回大廳');
await shot('match-end');

if (againVisible.shown) {
  await page.click('#again');
  await page.waitForFunction(() => (window.__brawl.state === 'fight' ? { s: 1 } : null), null, { timeout: 20000, polling: 60 });
  ok('再來一場真的重開', true, `round=${await page.evaluate(() => window.__brawl.round)}`);
}

/* ── 6. 手機直向(艦隊慣例:直向要有轉橫提示)────────────────────────── */
console.log('\n── 手機直向 ──');
await page.setViewportSize({ width: 390, height: 844 });
await advance(0.8);
const portrait = await page.evaluate(() => ({
  padShown: getComputedStyle(document.getElementById('pad')).display !== 'none',
  rotateHint: /橫向|轉橫|橫著|landscape/i.test(document.body.innerText),
  manifestOrientation: null,
  bodyScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
}));
const mani = await page.evaluate(async () => {
  try { const r = await fetch('./manifest.webmanifest'); const j = await r.json(); return { orientation: j.orientation || null, name: j.name }; }
  catch { return null; }
});
ok('直向有虛擬搖桿(手機玩得動)', portrait.padShown);
ok('直向有「請轉橫向」提示(force-landscape-pwa)', portrait.rotateHint, portrait.rotateHint ? '' : '直向沒有任何轉橫提示');
ok('manifest 鎖橫向', mani?.orientation === 'landscape', `orientation=${mani?.orientation ?? '(沒寫)'}`);
ok('直向沒有橫向溢出', !portrait.bodyScrollX);
await shot('portrait-390x844');

/* ── 收尾 ────────────────────────────────────────────────────────────── */
await browser.close();

const red = checks.filter((c) => !c.pass);
console.log('\n══════════════════════════════════════════════════════════');
console.log(`總計:${checks.length - red.length} 過 / ${red.length} 失敗`);
if (errors.length) {
  console.log(`\n⚠ 主控台/未捕捉錯誤 ${errors.length} 筆:`);
  for (const e of [...new Set(errors)].slice(0, 12)) console.log(`   ${e}`);
} else console.log('🟢 主控台沒有錯誤、沒有未捕捉例外');
if (red.length) { console.log('\n🔴 紅燈:'); for (const c of red) console.log(`   ${c.name}${c.detail ? ` — ${c.detail}` : ''}`); }
console.log(`\n📸 截圖 ${shots.length} 張在 ${OUT}/`);
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ url: URL, at: new Date().toISOString(), checks, errors: [...new Set(errors)], shots }, null, 2));
process.exit(errors.length ? 1 : 0);
