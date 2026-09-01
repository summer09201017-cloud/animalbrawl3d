/* UI 接線:選單 / HUD / 鍵盤 / 觸控。★ 本檔不碰物理內部,只透過 Game 的方法。 */
import * as THREE from 'three';
import { Game, KINDS, KIND_LIST, TEAM } from './game.js';
import { Audio } from './audio.js';

const $ = id => document.getElementById(id);
const audio = new Audio();

/* ⑦ 版本號 + 新增功能簡歷(game-must-haves):選單上看得到「這是第幾版、這一版多了什麼」。
   老師/使用者才分得出手上的是不是新版,回報問題時也講得出版本。
   ★ 改了會上線的東西 ⇒ 這兩行與 public/sw.js 的 CACHE **一起** bump。*/
const VER = 'v1.3';
const VER_NOTES = '物理布娃娃互推・四種動物・四視角・同機兩人或對電腦'
  + '｜v1.1:修好 HUD 與「再來一場」不顯示'
  + '｜v1.2:返回大廳鈕・角色放大看得清・天空看得到雲・俯瞰固定在場地中心｜v1.3:接上使用統計';
let game = null, raf = 0, last = 0;

/* ── 鍵盤配置(同機兩人)。★ 3d-game-kit §3「量值可調」:鍵位也印在畫面上,
      不要只寫在 README —— 兩個孩子搶鍵盤的時候沒人會去讀 README。*/
const KEYS = [
  { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'KeyF', punch: 'KeyG', grab: 'KeyH',
    show: 'WASD 移動 · F 跳 · G 出拳 · H 抓/丟' },
  { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', jump: 'Numpad1', punch: 'Numpad2', grab: 'Numpad3',
    show: '方向鍵移動 · 小鍵盤 1 跳 · 2 出拳 · 3 抓/丟' },
];
const held = new Set();
let touchVec = null;      // 觸控搖桿目前的向量(bindTouch 設好)

/* 移動方向要**相對鏡頭**,不是相對世界。
   ⚠⚠ 3d-game-kit 實錄(sheepflock3d 0826):加了固定機位之後「按右卻往左轉」——
     因為固定機位下角色朝鏡頭走來時,他的右手邊在畫面上是左邊。
   ⇒ 這裡直接用鏡頭的右向量與前向量組合輸入,所有視角一致:按右永遠往畫面右走。*/
const _fwd = new THREE.Vector3();
/** 把「畫面上的上下左右」換成世界座標的移動方向(一號還會併進觸控搖桿)。*/
function moveFromKeys(k, idx) {
  let ax = 0, az = 0;
  if (held.has(k.left)) ax -= 1;
  if (held.has(k.right)) ax += 1;
  if (held.has(k.up)) az += 1;
  if (held.has(k.down)) az -= 1;
  /* 一號:鍵盤沒按時吃觸控搖桿(兩者同一條換算路,不要各寫一份)*/
  if (!ax && !az && idx === 0 && touchVec && (touchVec.dx || touchVec.dz)) {
    ax = touchVec.dx; az = touchVec.dz;
  }
  if (!ax && !az) return { dx: 0, dz: 0 };
  game.camera.getWorldDirection(_fwd); _fwd.y = 0;
  if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
  _fwd.normalize();
  const rx = -_fwd.z, rz = _fwd.x;                    // cross(up, forward)
  return { dx: _fwd.x * az + rx * ax, dz: _fwd.z * az + rz * ax };
}

function hudHTML(h) {
  const bar = h.players.map(p => `
    <div class="pl" style="--c:${p.css}">
      <div class="nm">${p.label}<span class="kd">${p.kind}</span>${p.ai ? '<span class="ai">電腦</span>' : ''}</div>
      <div class="sc">${'●'.repeat(p.score)}${'○'.repeat(Math.max(0, h.winScore - p.score))}</div>
      <div class="st">${p.dizzy ? '😵 頭暈' : p.held ? '✊ 抓著人' : p.onEdge ? '⚠ 快掉了!' : '　'}</div>
    </div>`).join('');
  return `<div class="hudbar">${bar}</div>
    <div class="mid">${h.msg ? `<div class="msg">${h.msg}</div>` : ''}</div>
    <div class="vw">視角:${h.view}(V 切換)</div>`;
}

function loop(t) {
  raf = requestAnimationFrame(loop);
  const dt = last ? Math.min(0.05, (t - last) / 1000) : 1 / 60;
  last = t;
  if (!game) return;
  game.setMoves([moveFromKeys(KEYS[0], 0), moveFromKeys(KEYS[1], 1)]);
  game.update(dt);
  game.render();
  const h = game.hud();
  $('hud').innerHTML = hudHTML(h);
  /* ⚠⚠ 不可以寫 `style.display = ''` —— 那是「清掉 inline 樣式、回到 CSS 的預設」,
       而 #again 在 CSS 裡的預設正是 `display:none` ⇒ 鈕永遠不會出現。
       (0901 真瀏覽器驗收抓到:比賽結束後鈕高 0px。平板沒有實體鍵盤按不到 R,
        比賽一結束就卡死,而 headless 測試看的是 hud() 的資料、一路全綠。)
       ⇒ 顯示一律給**明確值**。同族的 #hud 見 start()。*/
  $('again').style.display = h.state === 'matchEnd' ? 'block' : 'none';
}

function resize() {
  if (!game) return;
  game.resize(innerWidth, innerHeight);
}

async function start(cfg) {
  $('menu').style.display = 'none';
  $('hud').style.display = 'block';        // ★ 不是 ''(CSS 預設是 none,見 loop() 那條註解)
  game = new Game($('cv'), {
    winScore: cfg.winScore,
    onEvent: e => {
      if (e.type === 'swing') audio.swing();
      else if (e.type === 'hit') audio.hit(e.hard);
      else if (e.type === 'grab') audio.grab();
      else if (e.type === 'throw') audio.throwIt();
      else if (e.type === 'fall') { audio.fall(); setTimeout(() => audio.point(), 400); }
      else if (e.type === 'matchEnd') {
        setTimeout(() => audio.win(), 500);
        /* ② 完賽打點:分母是「開啟次數」,這一發是分子 —— 兩個一起看才知道
           「打開的人有多少真的打完一場」。psPing 由 index.html 定義,離線時它自己靜默。*/
        window.psPing?.('animalbrawl3d-done');
      }
    },
  });
  await game.init(cfg);
  resize();
  cancelAnimationFrame(raf); last = 0; raf = requestAnimationFrame(loop);
  window.__brawl = game;                     // dev hook(Playwright 驗證用,見 3d-game-kit)
}

/* ── 選單 ─────────────────────────────────────────────────────────────── */
function buildMenu() {
  const pick = (i) => KIND_LIST.map(k =>
    `<option value="${k}"${(i === 0 && k === 'cat') || (i === 1 && k === 'dog') ? ' selected' : ''}>${KINDS[k].name}</option>`).join('');
  $('menu').innerHTML = `
    <h1>🐾 毛毛大亂鬥</h1>
    <p class="sub">把對手推下台就得分。物理布娃娃 —— 站不穩才好笑。</p>
    <div class="rows">
      ${[0, 1].map(i => `
        <label class="row"><span class="lb" style="color:${TEAM[i].css}">${TEAM[i].label}</span>
          <select id="k${i}">${pick(i)}</select>
          <label class="chk"><input type="checkbox" id="ai${i}"${i === 1 ? ' checked' : ''}> 電腦操作</label>
        </label>`).join('')}
      <label class="row"><span class="lb">幾分獲勝</span>
        <select id="ws"><option>1</option><option>2</option><option selected>3</option><option>5</option></select>
      </label>
      <label class="row"><span class="lb">台子大小</span>
        <select id="ar"><option value="3.6">小(很快掉)</option><option value="5" selected>中</option><option value="6.5">大(慢慢玩)</option></select>
      </label>
    </div>
    <button id="go" class="go">開始!</button>
    <div class="keys">${KEYS.map((k, i) => `<div><b style="color:${TEAM[i].css}">${TEAM[i].label}</b> ${k.show}</div>`).join('')}
      <div class="dim">V 切換視角 · R 重新開始 · 手機請用畫面下方的按鈕</div>
      <div class="ver">${VER} · ${VER_NOTES}</div></div>`;
  $('go').onclick = () => start({
    kinds: [$('k0').value, $('k1').value],
    ai: [$('ai0').checked, $('ai1').checked],
    winScore: +$('ws').value,
    arenaRadius: +$('ar').value,
  });
}

addEventListener('keydown', e => {
  if (e.repeat) return;
  held.add(e.code);
  if (!game) return;
  if (e.code === 'KeyV') { game.cycleView(); e.preventDefault(); return; }
  if (e.code === 'KeyR') { game.restart(); e.preventDefault(); return; }
  for (let i = 0; i < KEYS.length; i++) {
    const k = KEYS[i];
    if (e.code === k.jump) { if (game.doJump(i)) audio.jump(); e.preventDefault(); }
    if (e.code === k.punch) { game.doPunch(i); e.preventDefault(); }
    if (e.code === k.grab) { game.doGrab(i); e.preventDefault(); }
  }
});
addEventListener('keyup', e => held.delete(e.code));
addEventListener('blur', () => held.clear());        // 切走再回來不要卡住方向鍵
addEventListener('resize', resize);

/* ── 觸控:左半螢幕搖桿 + 右下三顆鈕(平板上兩個孩子擠一台也玩得動)──────── */
function bindTouch() {
  const pad = $('pad'), stick = $('stick');
  let id = null, cx = 0, cy = 0;
  const vec = { dx: 0, dz: 0 };
  const setStick = (x, y) => { stick.style.transform = `translate(${x}px,${y}px)`; };
  pad.addEventListener('pointerdown', e => {
    id = e.pointerId; const r = pad.getBoundingClientRect();
    cx = r.left + r.width / 2; cy = r.top + r.height / 2;
    pad.setPointerCapture(id);
  });
  pad.addEventListener('pointermove', e => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - cx, dy = e.clientY - cy;
    const m = Math.min(1, Math.hypot(dx, dy) / 46);
    const a = Math.atan2(dy, dx);
    setStick(Math.cos(a) * m * 46, Math.sin(a) * m * 46);
    vec.dx = Math.cos(a) * m; vec.dz = -Math.sin(a) * m;
  });
  const end = e => { if (e.pointerId !== id) return; id = null; setStick(0, 0); vec.dx = vec.dz = 0; };
  pad.addEventListener('pointerup', end); pad.addEventListener('pointercancel', end);
  touchVec = vec;      // 一號的移動會吃它(見 moveFromKeys)
  $('btJump').onclick = () => { if (game && game.doJump(0)) audio.jump(); };
  $('btPunch').onclick = () => game && game.doPunch(0);
  $('btGrab').onclick = () => game && game.doGrab(0);
  $('btView').onclick = () => game && game.cycleView();
}


$('again').onclick = () => game && game.restart();

/* ── 返回大廳(back-to-lobby-button)───────────────────────────────────────
   ★ 退出 ≠ 過關:這條路徑完全不碰 onEvent/onComplete,不計分、不點亮大廳卡。
   ★ 比賽進行中才輕量確認(標題與結算畫面免確認,直接走)。
   ★ 先離開全螢幕再導頁 —— PWA 全螢幕下直接導頁會把使用者留在全螢幕的大廳裡。 */
const LOBBY_URL = 'https://hfpc-bible-games.summer09201017.workers.dev/';
$('lobby').onclick = () => {
  const playing = game && game.state === 'fight';
  if (playing && !confirm('離開這一關?這一場的比分不會保留。')) return;
  document.exitFullscreen?.().catch(() => { });
  location.href = LOBBY_URL;
};

buildMenu();
bindTouch();

/* PWA。★ 3d-game-kit 的 SW 地雷:dev 註冊 SW 會讓每次改動「慢一版」,
   測試會誤判半天 ⇒ localhost 一律不註冊。*/
if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => { }));
}
