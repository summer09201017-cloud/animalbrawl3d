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
/** 按住一個方向鍵,**逐小段**比對「這一段的位移」與「這一段開始時的鏡頭軸」,回中位數。
 *  回傳 { fwd, right, m }:fwd/right 各是「位移 vs 鏡頭前方 / 鏡頭右方」的餘弦中位數。
 *
 *  ★★ 為什麼一定要逐段、而且用「該段開始時」的鏡頭軸(0901 踩了三次才寫對):
 *    「跟隨(會轉)」視角的鏡頭黏在角色背後,角色一轉身鏡頭就繞過去(還有 0.3 秒 lerp 落後)。
 *    我原本「動完再取一次鏡頭方向」去比整段位移 —— 前後那條本機第一輪 +1.00、第二輪 -0.97;
 *    左右那條本機綠、**線上**翻成 -0.05。三次都不是遊戲壞了,是量法本身會翻號。
 *  ⚠ 還要「按回來」抵銷位移:第一版沒抵銷,台子半徑 3.6 而每個視角按 D 走 1.5~1.8 m
 *    ⇒ 驗收自己把角色走進虛空(髖部 y=-245 m),之後 6 條全紅、而且長得跟真 bug 一樣。 */
async function measureMove(code, back, s = 0.6, n = 6) {
  const seg = s / n;
  const fwdS = [], rightS = [];
  let why = '量滿全部分段';
  const probe = () => {
    const g = window.__brawl, pv = g.W.animals[0].parts.pelvis.translation();
    return {
      p: window.__chest(0), f: window.__camFwd(), r: window.__camRight(),
      rim: Math.hypot(pv.x, pv.z) / g.cfg.arenaRadius, y: pv.y,
    };
  };
  let x0 = await page.evaluate(probe);
  await page.keyboard.down(code);
  let total = 0;
  for (let i = 0; i < n; i++) {
    await advance(seg);
    const x1 = await page.evaluate(probe);
    const dx = x1.p.x - x0.p.x, dz = x1.p.z - x0.p.z;
    const m = Math.hypot(dx, dz);
    total += m;
    if (m > 0.01) {
      fwdS.push((dx * x0.f.x + dz * x0.f.z) / m);
      rightS.push((dx * x0.r.x + dz * x0.r.z) / m);
    }
    x0 = x1;
    /* ★ 快到台緣就收手(0.78 半徑)。0901 實錄:一次量到「總位移 11.12 m」——
       台子半徑只有 6.5,那不是走路,是**已經飛出去在墜落**;
       之後那條「按 W」量的就是彈道而不是輸入 ⇒ 假紅。
       ⇒ 驗收不該把受測對象弄壞;走到邊就停,手上的樣本已經夠算中位數了。*/
    if (x1.rim > 0.78) { why = `走到台緣(離心 ${x1.rim.toFixed(2)})`; break; }
    if (x1.y < 0.35) { why = `角色倒了/掉了(髖部 ${x1.y.toFixed(2)})`; break; }
  }
  await page.keyboard.up(code);
  await advance(0.2);
  /* ⚠⚠ 這裡原本是「按反方向鍵 0.63 秒抵銷位移」—— 一次**盲按、沒有台緣防護**。
     rAF 爆衝時那一按直接把角色走出台外(離心量到 1.93 倍半徑),
     於是下一條量測開頭就 break、樣本全空、報 0.00 m ⇒ 一條看起來很像真 bug 的假紅。
     ⇒ 回中心改用 recenter():它是分段的、每段都檢查離心,不會走過頭。*/
  await recenter();
  /* ★ 剔掉第一段:那是「從靜止起步」的過渡 —— 主動布娃娃要先把重心移過去才會走,
     實測第一段餘弦常是 0.02~0.24,而後面幾段都是 0.97~1.00。
     ⚠ 但只有樣本 ≥3 才剔,不然會把唯一的證據丟掉。*/
  const trim = (a) => (a.length >= 3 ? a.slice(1) : a);
  const med = (a) => { const q = [...trim(a)].sort((u, v) => u - v); return q.length ? q[Math.floor(q.length / 2)] : 0; };
  return { fwd: med(fwdS), right: med(rightS), fwdS, rightS, m: total, n: fwdS.length, why };
}

/** 先走回中央再量;樣本不足就再來一次。
 *  ⚠ 為什麼會樣本不足:無頭 Chromium 的 rAF 是**成串爆發**的,`advance(0.1s)` 之間
 *    遊戲時間可能一次衝過好幾秒(實測一段量到 7.95 m,那不是 0.1 秒走得完的距離)
 *    ⇒ 分段長度不精確,角色可能一段就走到台緣、迴圈提早收手只留 1 個樣本。
 *    方向本身是對的(那次餘弦 0.91),但 1 個樣本證據太薄 ⇒ 重來一次而不是判它紅。 */
async function measureTwice(code, back) {
  for (let attempt = 0; attempt < 3; attempt++) {
    /* 每次量測前把場地整理乾淨:①角色在台上且站得起來 ②對手挪開 ③走回中央。
       ★ 三件都要,而且順序固定 —— ensureAlive 會 restart(對手回到出生點),
         所以 parkFoe 一定要在它之後。*/
    for (let i = 0; i < 3 && !(await ensureAlive(`${code} 量測前`)); i++) { /* 站穩再量 */ }
    await parkFoe();
    await recenter();
    const r = await measureMove(code, back);
    if (r.n >= 2 || attempt === 2) return r;
    note(`${code} 只取到 ${r.n} 個樣本(${r.why})⇒ 整理場地重量一次`);
  }
}

/** 把二號整隻**平移**到台子一側停好,讓方向測試有一片空地。
 *  ⚠⚠ 為什麼要有這一步(0901 穩定重現的一條紅燈):側面視角量「按 W」時位移 0.00 m。
 *    不是輸入壞了 —— 是 recenter 之後兩隻站在一起,而**被我關掉 AI 的對手變成一面牆**,
 *    W 剛好把玩家推進對手身上。真人也推不動(互推就是這遊戲的核心),
 *    所以那是「驗法把受測項目跟另一件事纏在一起」,不是產品的錯。
 *  ★ 整隻一起平移(每個部位同一個位移)⇒ 關節相對位置不變,不會把布娃娃撕開;
 *    順手把速度歸零,免得它帶著動量滑回來。 */
async function parkFoe() {
  await page.evaluate(() => {
    const g = window.__brawl, a = g.W.animals[1];
    if (!a || a.fellAt != null) return;
    const R = g.cfg.arenaRadius, p = a.parts.pelvis.translation();
    const dx = R * 0.62 - p.x, dz = -p.z;
    for (const k of Object.keys(a.parts)) {
      const b = a.parts[k], t = b.translation();
      b.setTranslation({ x: t.x + dx, y: t.y, z: t.z + dz }, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  });
  await advance(0.6);
}

/** 用**真鍵盤**把一號走回台子中央附近,量測才不會從台緣起跑(起跑就停 ⇒ 只剩 1 個樣本)。*/
async function recenter(max = 8) {
  for (let i = 0; i < max; i++) {
    const st = await page.evaluate(() => {
      const g = window.__brawl, pv = g.W.animals[0].parts.pelvis.translation();
      const rim = Math.hypot(pv.x, pv.z) / g.cfg.arenaRadius;
      if (rim <= 0.4) return { rim, done: true };
      /* 已經掉出台外(或倒在台下)就別再用走路救 —— 交給 ensureAlive 重開 */
      if (rim > 0.95 || pv.y < 0.2) return { rim, done: true };
      /* 往場中心走:把「角色 → 場中心」換成畫面上的方向,再按對應的鍵 */
      const me = window.__proj(pv.x, 0.7, pv.z), mid = window.__proj(0, 0.7, 0);
      if (!me || !mid) return { rim, done: true };
      return { rim, done: false, dx: mid.x - me.x, dy: mid.y - me.y };
    });
    if (st.done) return st.rim;
    const keys = [];
    if (Math.abs(st.dx) > 0.02) keys.push(st.dx > 0 ? 'KeyD' : 'KeyA');
    if (Math.abs(st.dy) > 0.02) keys.push(st.dy > 0 ? 'KeyW' : 'KeyS');
    if (!keys.length) return st.rim;
    for (const k of keys) await page.keyboard.down(k);
    await advance(0.18);          // 短按:rAF 爆衝時一段 0.3 秒可能直接衝過中心到對面
    for (const k of keys) await page.keyboard.up(k);
    await advance(0.12);
  }
  return (await page.evaluate(() => {
    const g = window.__brawl, pv = g.W.animals[0].parts.pelvis.translation();
    return Math.hypot(pv.x, pv.z) / g.cfg.arenaRadius;
  }));
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
    /* ★★ 一定要回報 behind:在**鏡頭後方**的點,clip w 是負的,除下去會把 x/y 翻號
       ⇒ 一個在背後、其實看不到的東西,算出來的 NDC 可能落在 (-1,1) 裡面
       ⇒ 「框得住」會給出綠燈,而畫面上根本沒有它。
       0901 跟隨視角就是這樣:檢查全綠,截圖裡卻看不到對手。*/
    return { x: c[0] / c[3], y: c[1] / c[3], behind: c[3] < 0 };
  };
  window.__camOK = () => { const p = g.camera.position; return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z); };
  /* 鏡頭的水平前方向(matrixWorld 第三欄取負 = three 的 forward)*/
  window.__camFwd = () => {
    const m = g.camera.matrixWorld.elements;
    const fx = -m[8], fz = -m[10], l = Math.hypot(fx, fz) || 1;
    return { x: fx / l, z: fz / l };
  };
  /* 鏡頭的水平右方向(matrixWorld 第一欄 = 螢幕右)。
     ★ 用它而不是「畫面像素差」來驗左右:高空俯瞰的像素差極小、跟隨視角的像素差會翻號。
     這一欄在四個視角都對(含把 up 改成場地軸的俯瞰視角)。*/
  window.__camRight = () => {
    const m = g.camera.matrixWorld.elements;
    const rx = m[0], rz = m[2], l = Math.hypot(rx, rz) || 1;
    return { x: rx / l, z: rz / l };
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
  /* ★ 峰值要在**頁面自己的 rAF** 裡逐幀記,不能從外面每 0.07 秒問一次:
     無頭 Chromium 的 rAF 成串爆發,一次 advance 可能衝過好幾百毫秒
     ⇒ 從外面取樣會**直接跳過跳躍的最高點**,量到 +0.083 而不是 +0.52(0901 假紅)。*/
  window.__peak = { on: false, max: -1e9 };
  const recPeak = () => {
    if (window.__peak.on) window.__peak.max = Math.max(window.__peak.max, window.__pelvisY(0));
    requestAnimationFrame(recPeak);
  };
  requestAnimationFrame(recPeak);
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
  /* ★★ ensureAlive 必須在**所有量測之前** —— 0901 第二次踩:原本它放在方向量測前面、
     但「框得住 / 角色多大 / 看得到幾朵雲」三項在它上面 ⇒ 前一個視角把角色打下台時,
     這三項量的是一隻**正在墜落**的動物(NDC y=-2.71、佔畫面 0.4%)⇒ 三條假紅。
     教訓同一句:紅了先問「是不是我的驗法」;而驗法的順序本身就是驗法的一部分。*/
  for (let i = 0; i < 3 && !(await ensureAlive(`${name} 量測前`)); i++) { /* 站穩再量 */ }
  await advance(1.3);                                    // 等鏡頭 lerp 收斂(觀感截圖,可以等時間)
  const camOK = await page.evaluate(() => window.__camOK());
  ok(`${name}:鏡頭座標沒有 NaN`, camOK);
  /* 邊界收到 ±0.94:貼在畫面最邊緣等於「看得到一角」,對孩子不算看得到。
     並排除「在鏡頭後方」(見 __proj 的註解)。*/
  const framed = await page.evaluate(() => {
    const out = [];
    for (let i = 0; i < 2; i++) { const p = window.__chest(i); out.push(window.__proj(p.x, p.y, p.z)); }
    return out;
  });
  const inFrame = framed.every((p) => p && !p.behind && Math.abs(p.x) <= 0.94 && Math.abs(p.y) <= 0.94);
  ok(`${name}:兩隻都在畫面裡(含邊界留白)`, inFrame,
    framed.map((p) => p ? `(${p.x.toFixed(2)},${p.y.toFixed(2)})${p.behind ? '🔴在鏡頭後方' : ''}` : 'null').join(' '));

  /* ★ 投影可讀性:角色在畫面上有多高。教室投影孩子坐最後一排,太小就看不出誰是誰。
     量法:頭頂與腳底投影到 NDC 的距離 → 換成畫面高度百分比。*/
  const figure = await page.evaluate(() => {
    const g = window.__brawl, a = g.W.animals[0];
    const h = a.parts.head.translation(), f = a.parts.pelvis.translation();
    const top = window.__proj(h.x, h.y + 0.30, h.z), bot = window.__proj(f.x, f.y - 0.62, f.z);
    if (!top || !bot || top.behind || bot.behind) return 0;
    return Math.abs(top.y - bot.y) / 2 * 100;      // NDC 高 2 = 畫面 100%
  });
  const key = ['fixed', 'side', 'top', 'chase'][idx];
  if (key === 'top') {
    /* 高空俯瞰的職責是「一眼看到整個台子」,角色必然小(13 公尺寬的台子要塞進畫面)
       ⇒ 這個視角不套字級門檻,改驗它該做的事:台子四個邊都在框內。*/
    const fits = await page.evaluate(() => {
      const R = window.__brawl.cfg.arenaRadius, pts = [];
      for (const [dx, dz] of [[R, 0], [-R, 0], [0, R], [0, -R]]) pts.push(window.__proj(dx, 0, dz));
      return pts.every((p) => p && !p.behind && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1);
    });
    ok(`${name}:整個台子框得住(這個視角的職責)`, fits, `角色佔 ${figure.toFixed(1)}%,俯瞰不套字級門檻`);
  } else {
    /* 門檻按「這個視角的職責」分開,不是一個數字套四個視角 ——
       固定機位是**預設、也是老師投影用的那一個** ⇒ 要求最嚴(14%,約 100px 高 @720p);
       側面/跟隨是替代機位,拿角度換一點大小是合理取捨 ⇒ 12%。
       ★ 誠實聲明:這是為了避免「為了同一個數字把所有鏡頭都硬拉近」而定的分級,
         不是為了讓紅燈變綠。使用者當初指出的就是**固定機位**的角色偏小。*/
    const bar = key === 'fixed' ? 14 : 12;
    ok(`${name}:角色夠大(投影後排看得到)`, figure >= bar, `佔畫面高 ${figure.toFixed(1)}%(門檻 ${bar}%)`);
  }

  /* ★ 雲:「有沒有畫」跟「看不看得見」是兩件事。原本 16 朵都在,而畫面上一朵都沒有
     (材質吃了同色的霧 + 擺太高 + 離太遠)。⇒ 數「投影在框內、又不在鏡頭後方」的朵數。
     俯瞰視角是往下看地面,本來就看不到天空的雲 ⇒ 不要求。*/
  if (key !== 'top') {
    const cloudsSeen = await page.evaluate(() => {
      const cs = window.__brawl.clouds || [];
      let n = 0;
      for (const c of cs) {
        const p = window.__proj(c.position.x, c.position.y, c.position.z);
        if (p && !p.behind && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1) n++;
      }
      return { n, total: cs.length };
    });
    ok(`${name}:天空看得到雲`, cloudsSeen.n >= 2, `框內 ${cloudsSeen.n} / 共 ${cloudsSeen.total} 朵`);
  }

  /* 驗的是**方向**,不是幅度 —— 而且用「鏡頭的右向量」而不是畫面像素差:
     高空俯瞰在 14 公尺上方,走 0.42 m 在畫面上只有 +0.004(拿幅度門檻卡它會假紅);
     跟隨視角的鏡頭又會轉(拿前後兩點的畫面差會翻號)。兩個毛病一次解掉。*/
  /* ★ 順序講究:框得住 / 角色多大 / 幾朵雲 這三項要在**自然位置**下量(上面已經量完);
     方向測試才由 measureTwice 自己整理場地(挪開對手、回中央)——
     兩件事分開,一條紅燈才指得出一個原因。*/
  const rt = await measureTwice('KeyD', 'KeyA');
  ok(`${name}:按 D 真的往畫面右走`, rt.right > 0.3 && rt.n >= 2,
    `逐幀餘弦中位數 ${rt.right.toFixed(2)}(${rt.rightS.map((v) => v.toFixed(2)).join(' ')})・總位移 ${rt.m.toFixed(2)}m`);
  /* ★★ 會轉的鏡頭要**逐幀**比,不能「動完再取一次鏡頭方向」:
       跟隨視角的鏡頭黏在角色背後,角色一轉身鏡頭就繞過去(還有 0.3 秒的 lerp 落後)。
       同一段驗收碼第一輪量到 +1.00、第二輪 -0.97 —— 不是遊戲壞了,是我在拿
       「動作結束後的鏡頭方向」去比「整段位移」。⇒ 每小段各自比,取中位數。*/
  /* ★ 左右用「畫面座標」驗,前後用「鏡頭前方」驗 —— 這不是放水,是這兩件事本來就不同:
       跟隨視角的鏡頭是黏在角色背後的,角色往前走時**鏡頭跟著走**,
       所以「往前」在畫面上幾乎不動(是世界往後退)⇒ 拿畫面 y 去驗前後,
       在跟隨視角必然假紅(第一版就紅在這裡,我差點去改產品)。
       使用者真正在意的那句話是「按 W 會往我看的方向走」= 與鏡頭前方同向。*/
  const fw = await measureTwice('KeyW', 'KeyS');
  ok(`${name}:按 W 真的往鏡頭前方走`, fw.fwd > 0.3 && fw.n >= 2,
    `逐幀餘弦中位數 ${fw.fwd.toFixed(2)}(${fw.fwdS.map((v) => v.toFixed(2)).join(' ')})・總位移 ${fw.m.toFixed(2)}m`);

  await shot(`view-${idx}-${['fixed', 'side', 'top', 'chase'][idx]}`);
  await page.keyboard.press('KeyV');
  await page.waitForFunction((prev) => (window.__brawl.viewIdx !== prev ? { v: window.__brawl.viewIdx } : null), idx, { timeout: 10000, polling: 60 });
}
ok('V 鍵繞完四個視角回到原點', (await page.evaluate(() => window.__brawl.viewIdx)) === 0);

/* ── 4. 手感:跳得起來 / 拳頭打得到 ─────────────────────────────────── */
console.log('\n── 手感 ──');
for (let i = 0; i < 3 && !(await ensureAlive('手感段')); i++) { /* 站穩了才量跳躍 */ }
await advance(0.5);
/* ★ jump() 有三道閘門(冷卻 0.45s / 被打暈 hp<0.6 / 必須著地)。
   「按下去那一刻剛好在踏步的半空」⇒ 這一下被拒,而畫面上什麼都不會發生。
   ⇒ 先等到「可以跳」再按真鍵盤,再用引擎確認**這一下被接受了**(成功才會把 cd.jump 設成 0.45),
     被拒就重試。不這樣做,這條會偶發假紅(0901 實際紅過一次:0.634 → 0.640)。*/
let jumped = false, standY = 0, peak = 0;
for (let attempt = 0; attempt < 5 && !jumped; attempt++) {
  await page.waitForFunction(() => {
    const a = window.__brawl.W.animals[0];
    return a.cd.jump <= 0 && a.hp >= 0.6 ? { ok: 1 } : null;
  }, null, { timeout: 8000, polling: 60 }).catch(() => { });
  standY = await page.evaluate(() => {
    window.__peak.max = -1e9; window.__peak.on = true;      // 開始逐幀記峰值
    return window.__pelvisY(0);
  });
  await page.keyboard.press('KeyF');
  const accepted = await page.waitForFunction(
    () => (window.__brawl.W.animals[0].cd.jump > 0 ? { c: 1 } : null), null, { timeout: 1500, polling: 30 },
  ).then(() => true).catch(() => false);
  if (!accepted) {
    await page.evaluate(() => { window.__peak.on = false; });
    note(`按 F 第 ${attempt + 1} 次被拒(那一刻不在著地)⇒ 再試`); await advance(0.45); continue;
  }
  await advance(0.8);                                        // 讓整段跳躍跑完
  peak = await page.evaluate(() => { window.__peak.on = false; return window.__peak.max; });
  jumped = true;
}
ok('按 F 真的跳起來', jumped && peak - standY > 0.12,
  jumped ? `髖部 ${standY.toFixed(3)} → 最高 ${peak.toFixed(3)} m(+${(peak - standY).toFixed(3)})` : '五次都在半空,按不到著地那一刻');

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

/* ── 7. 返回大廳(game-must-haves ④ / back-to-lobby-button)──────────────
   ★ 這一項**真的把鈕點下去**,不是掃頁面上有沒有「大廳」兩個字 ——
     鈕存在、看得見、點得到、而且真的導到大廳,是四件不同的事。
   ★ 放在最後一項:它會導航離開,後面就沒得驗了。*/
console.log('\n── 返回大廳 ──');
await page.setViewportSize({ width: 1280, height: 720 });
await advance(0.5);
const lobbyBtn = await page.evaluate(() => {
  const s = window.__seen('#lobby');
  const el = document.getElementById('lobby');
  return { ...s, text: el ? el.textContent.trim() : null };
});
ok('返回大廳鈕看得見', !lobbyBtn.hidden, `${lobbyBtn.w}×${lobbyBtn.h}・「${lobbyBtn.text}」`);
ok('返回大廳鈕觸控目標 ≥44px', lobbyBtn.w >= 44 && lobbyBtn.h >= 44, `${lobbyBtn.w}×${lobbyBtn.h}`);
if (!lobbyBtn.hidden) {
  /* 比賽進行中會跳輕量確認 ⇒ 先掛 dialog 處理器按「確定」。
     ⚠ 沒掛的話 Playwright 預設**自動取消**,於是導航不會發生,看起來像鈕壞了。*/
  page.on('dialog', (d) => d.accept().catch(() => { }));
  const before = page.url();
  await page.click('#lobby');
  const moved = await page.waitForFunction(
    (prev) => (location.href !== prev ? { u: location.href } : null), before, { timeout: 15000, polling: 100 },
  ).then(() => true).catch(() => false);
  const now = page.url();
  ok('★ 點下去真的導到大廳', moved && /hfpc-bible-games/.test(now), `→ ${now.slice(0, 70)}`);
}

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
