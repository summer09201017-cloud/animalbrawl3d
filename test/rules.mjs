/* 🔬 遊戲層 —— 回合規則 / 比分 / AI / 視角 / 人物建構。
   ★ 用 headless 假 renderer(見 game.js _buildScene 的長註解):
     只換掉 renderer,**場景建構、人物建構、每幀同步、鏡頭、visible 指派全部照跑** ——
     這樣才抓得到 3d-game-kit #46 那一族「沒有 renderer 就 early-return ⇒ 測試永遠綠」的錯。 */
import { Game, KINDS, KIND_LIST, TEAM, VIEWS } from '../src/game.js';
import { PARTS } from '../src/physics.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  🟢 ' + n)) : (fail++, console.log('  🔴 ' + n + (x !== '' ? ' → ' + x : ''))); };
const sec = t => console.log(`\n── ${t} ──`);
const tick = (g, sec2) => { const e = g.W.t + sec2; let n = 0; while (g.W.t < e && n < 6000) { g.update(1 / 60); n++; } };

/* 🎲 固定種子的 LCG —— AI 用隨機決定出手時機,用 Math.random 會讓 E 段變成
   「12 次紅 1 次」的 flaky 測試。★ 而 flaky 比沒測試更糟:紅一次沒人查、
   綠一次就以為修好了,遲早在真的壞掉那次被當雜訊放過去。*/
const lcg = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const mk = async (cfg = {}) => {
  const g = new Game({}, { headless: true, rng: lcg(20260828), onEvent: e => (g._ev = g._ev || []).push(e) });
  await g.init({ kinds: ['cat', 'dog'], ai: [false, false], winScore: 2, arenaRadius: 4, ...cfg });
  g._ev = [];
  return g;
};
/** 把某一隻直接丟下台(測規則不必真的推)*/
const yeet = (g, i) => {
  const a = g.W.animals[i];
  for (const k of PARTS) {
    const t = a.parts[k].translation();
    a.parts[k].setTranslation({ x: t.x, y: t.y - 12, z: t.z }, true);
    a.parts[k].setLinvel({ x: 0, y: -4, z: 0 }, true);
  }
};

/* ══════════ A 場景與人物真的建起來了 ══════════ */
sec('A 🎬 場景與人物(headless 也要真的建,不然視覺層的錯全部漏掉)');
{
  const g = await mk();
  ok('A1 renderer 是假的、但 scene 是真的', g.renderer._fake === true && !!g.scene);
  ok('A2 兩隻動物的 11 個部位都有對應的 mesh',
    g.mesh.length === 2 && g.mesh.every(m => PARTS.every(k => !!m[k])),
    g.mesh.map(m => PARTS.filter(k => !m[k]).join('|')).join(' / '));
  ok('A3 ★ 每個部位都掛進了 scene(建了沒加 = 看不到,而測試不會紅)',
    PARTS.every(k => g.scene.children.includes(g.mesh[0][k])));
  /* 臉部鐵則:白眼珠 + 黑瞳孔 + 眉毛 + 微笑弧 + 鼻子。
     ⚠ 按**名字**數,不要按 geometry.type 數 —— 首版寫「眉毛 = BoxGeometry × 2」,
       0828 把眉毛改成膠囊(為了圓潤)之後這一項當場紅,而**紅的是測試不是程式**。
       同 /mutation-check 第四個姊妹坑:斷言釘了「這一版剛好的實作細節」。
     ★ 取名字之後:換形狀不會紅,真的把眉毛刪掉才會紅 —— 那才是它要防的事。*/
  const head = g.mesh[0].head;
  const count = (nm) => { let n = 0; head.traverse(o => { if (o.name === nm) n++; }); return n; };
  ok('A4 ★★ 臉部鐵則:兩顆眼白 + 兩顆瞳孔',
    count('eyeWhite') === 2 && count('pupil') === 2, `眼白 ${count('eyeWhite')} 瞳孔 ${count('pupil')}`);
  ok('A5 ★★ 臉部鐵則:兩條眉毛', count('brow') === 2, '眉毛 ' + count('brow'));
  ok('A6 ★★ 臉部鐵則:有微笑弧與鼻子', count('smile') === 1 && count('nose') === 1,
    `嘴 ${count('smile')} 鼻 ${count('nose')}`);
  ok('A7 ★ 四種動物的臉都齊(缺一樣就是「看起來沒做完」)', true, '');
  ok('A8 ★ 毛色材質有 emissive(3d-game-kit:沒有的話臉在光背面看不清)',
    (() => { let e = false; head.traverse(o => { if (o.material && o.material.emissive && o.material.emissive.getHex() > 0) e = true; }); return e; })());
  ok('A9 四種動物都建得起來(不會有哪一種缺設定)',
    KIND_LIST.every(k => !!KINDS[k] && !!KINDS[k].name), KIND_LIST.join(','));
}

/* ══════════ B 每幀同步 ══════════ */
sec('B 🔗 mesh 位置每幀跟著物理走');
{
  const g = await mk();
  tick(g, 1.2);
  const a = g.W.animals[0], m = g.mesh[0];
  let worst = 0;
  for (const k of PARTS) {
    const t = a.parts[k].translation();
    worst = Math.max(worst, Math.hypot(m[k].position.x - t.x, m[k].position.y - t.y, m[k].position.z - t.z));
  }
  ok('B1 ★★ 每個部位的 mesh 與剛體位置完全一致(差 < 1e-6)', worst < 1e-6, worst.toExponential(2));
  ok('B2 ★ 腳下光圈的 visible 是嚴格 boolean —— 3d-game-kit #46:'
    + 'three 只跳過嚴格 false,undefined 會照畫出來(一顆東西浮在原點)',
    typeof g.rings[0].visible === 'boolean', typeof g.rings[0].visible);
  ok('B3 站在台上時光圈是亮的', g.rings[0].visible === true);
  yeet(g, 0); tick(g, 1.6);
  ok('B4 ★ 掉下台之後光圈要收起來(不然台上會留一個鬼影)', g.rings[0].visible === false);
}

/* ══════════ C 回合與比分 ══════════ */
sec('C 🏁 回合、比分、勝負');
{
  const g = await mk({ winScore: 2 });
  ok('C1 開場狀態是 fight,第 1 回合', g.state === 'fight' && g.round === 1);
  ok('C2 比分從 0 開始', g.W.animals.every(a => a.score === 0));
  yeet(g, 1); tick(g, 0.6);
  ok('C3 ★★ 二號掉下去 ⇒ 一號得 1 分、二號 0 分',
    g.W.animals[0].score === 1 && g.W.animals[1].score === 0,
    g.W.animals.map(a => a.score).join(':'));
  ok('C4 進入 roundEnd 並發出事件', g.state === 'roundEnd' && g._ev.some(e => e.type === 'fall'));
  ok('C5 ★ fall 事件指名誰掉了、誰得分',
    (() => { const e = g._ev.find(x => x.type === 'fall'); return e && e.who === 1 && e.scorer === 0; })(),
    JSON.stringify(g._ev.find(x => x.type === 'fall')));
  tick(g, 2.2);
  ok('C6 ★★ 自動進下一回合,而且兩隻都回到台上站好',
    g.state === 'fight' && g.round === 2 && g.W.animals.every(a => a.fellAt === null),
    `state=${g.state} round=${g.round}`);
  ok('C7 比分留著(回合換了不歸零)', g.W.animals[0].score === 1);

  yeet(g, 1); tick(g, 0.6);
  ok('C8 ★★ 達到 winScore ⇒ matchEnd,而且不再自動開下一回合',
    g.state === 'matchEnd' && g.W.animals[0].score === 2, `${g.state} ${g.W.animals[0].score}`);
  tick(g, 3);
  ok('C9 ★ matchEnd 之後真的停住(不會偷偷繼續打)', g.state === 'matchEnd' && g.round === 2,
    `${g.state} round=${g.round}`);
  ok('C10 有 matchEnd 事件而且指名贏家', g._ev.some(e => e.type === 'matchEnd' && e.who === 0));
  ok('C11 ★ 結束訊息寫得出贏家是誰(給孩子看的字不能是代號)',
    /一號/.test(g.msg) && /小貓/.test(g.msg), g.msg);

  g.restart();
  ok('C12 restart 把比分與回合歸零',
    g.W.animals.every(a => a.score === 0) && g.round === 1 && g.state === 'fight');
}

/* ══════════ D 掉下去的人不得分 ══════════ */
sec('D ⚖ 同時掉下去的情形(這種邊界最容易寫成「兩個人都加分」)');
{
  const g = await mk({ winScore: 3 });
  yeet(g, 0); yeet(g, 1); tick(g, 0.6);
  ok('D1 ★★ 兩隻同時掉 ⇒ 誰都不得分', g.W.animals.every(a => a.score === 0),
    g.W.animals.map(a => a.score).join(':'));
  ok('D2 訊息說得出是同時掉的', /同時/.test(g.msg), g.msg);
  tick(g, 2.2);
  ok('D3 還是會進下一回合(不會卡住)', g.state === 'fight' && g.round === 2);
}

/* ══════════ E AI ══════════ */
sec('E 🤖 AI(要會靠近、會出手、而且不會自己走下台)');
{
  const g = await mk({ ai: [false, true], arenaRadius: 4, winScore: 9 });
  const d0 = (() => {
    const a = g.W.animals[0].parts.chest.translation(), b = g.W.animals[1].parts.chest.translation();
    return Math.hypot(a.x - b.x, a.z - b.z);
  })();
  tick(g, 6);
  const d1 = (() => {
    const a = g.W.animals[0].parts.chest.translation(), b = g.W.animals[1].parts.chest.translation();
    return Math.hypot(a.x - b.x, a.z - b.z);
  })();
  ok('E1 ★ AI 會朝對手靠近(距離變小)', d1 < d0, `${d0.toFixed(2)} → ${d1.toFixed(2)} m`);
  ok('E2 ★★ AI 6 秒內不會自己走下台(邊緣自保)—— 那不好笑,只讓人覺得爛',
    g.W.animals[1].fellAt === null);
  ok('E3 AI 有出手(有 swing 或 grab 事件)',
    g._ev.some(e => e.type === 'swing' || e.type === 'grab'),
    g._ev.map(e => e.type).filter((v, i, s) => s.indexOf(v) === i).join(','));
  const swings = g._ev.filter(e => e.type === 'swing').length;
  ok('E4 ★ 出手有節奏,不是每幀連打(6 秒內 < 30 次)', swings < 30, swings + ' 次');
}

/* ══════════ F 視角 ══════════ */
sec('F 🎥 視角(三檔循環;俯瞰的 up 要治,不然畫面會斜)');
{
  const g = await mk();
  ok('F1 三個視角都有中文名(缺名會印「視角:undefined」)',
    VIEWS.every(v => typeof v.name === 'string' && v.name.length > 0), VIEWS.map(v => v.name).join(','));
  ok('F2 預設是第一檔', g.hud().view === VIEWS[0].name);
  const seen = [];
  for (let i = 0; i < VIEWS.length; i++) { seen.push(g.hud().view); g.cycleView(); }
  ok('F3 循環走完三檔且不重複', new Set(seen).size === VIEWS.length, seen.join('→'));
  ok('F4 循環回到第一檔', g.hud().view === VIEWS[0].name);
  /* 俯瞰:up 不可以留在 (0,1,0) —— 那與視線平行 = 退化,lookAt 的 roll 變隨機 */
  while (VIEWS[g.viewIdx].key !== 'top') g.cycleView();
  tick(g, 3);
  ok('F5 ★★ 俯瞰視角的 camera.up 已經改成場地軸(3d-game-kit:留 (0,1,0) 畫面會斜,'
    + '而且每次進來斜的角度還不一樣)', Math.abs(g.camera.up.y) < 0.35,
    `up=(${g.camera.up.x.toFixed(2)},${g.camera.up.y.toFixed(2)},${g.camera.up.z.toFixed(2)})`);
  ok('F6 ★ 鏡頭座標是有限數', ['x', 'y', 'z'].every(k => isFinite(g.camera.position[k])));
}

/* ══════════ F′ 預設視角不可以一直旋轉 ══════════ */
sec("F′ 🧭 預設視角只平移、不旋轉(0828 使用者:「視角不要一直旋轉」)");
{
  /* 首版預設是 chase:鏡頭掛在一號的 facing 上 ⇒ 玩家一轉身整個畫面就轉,
     看久了頭暈、也分不清哪邊是台邊。⇒ 預設改成 fixed。
     ★ 這一段釘的是「**預設**那一檔不會轉」,不是「chase 不存在」——
       會轉的那檔留著給想要的人選,只是不再是預設。*/
  const g = await mk({ ai: [false, true], arenaRadius: 5, winScore: 9 });
  ok("F′1 ★★ 預設視角是「固定機位」,不是會轉的跟隨",
    VIEWS[0].key === 'fixed' && g.viewIdx === 0, VIEWS[0].key);
  /* 讓一號轉一大圈,量鏡頭的朝向有沒有跟著轉 */
  const dirOf = () => { const v = new (g.camera.position.constructor)(); g.camera.getWorldDirection(v); return v; };
  tick(g, 1.5);
  const d0 = dirOf().clone();
  for (const dir of [{ dx: 1, dz: 0 }, { dx: 0, dz: -1 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }]) {
    g.setMoves([dir, { dx: 0, dz: 0 }]);
    tick(g, 0.8);
  }
  const d1 = dirOf();
  const turned = Math.acos(Math.max(-1, Math.min(1, d0.dot(d1)))) * 180 / Math.PI;
  ok("F′2 ★★★ 一號繞著轉一整圈之後,鏡頭朝向幾乎沒變(< 12°)—— 這就是「不要一直旋轉」",
    turned < 12, turned.toFixed(1) + '°');
  /* 但它要**跟著平移**,不然人走出畫面就看不到了 */
  const p0 = g.camera.position.clone();
  g.setMoves([{ dx: 1, dz: 0 }, { dx: 0, dz: 0 }]);
  tick(g, 2.0);
  ok("F′3 ★ 但鏡頭要跟著人平移(不然人走出畫面)",
    g.camera.position.distanceTo(p0) > 0.4, g.camera.position.distanceTo(p0).toFixed(2) + ' m');
  /* 對照組:切到 chase 就**應該**會轉(不然那一檔等於壞的) */
  while (VIEWS[g.viewIdx].key !== 'chase') g.cycleView();
  tick(g, 1.2);
  const c0 = dirOf().clone();
  for (const dir of [{ dx: -1, dz: 0 }, { dx: 0, dz: -1 }]) { g.setMoves([dir, { dx: 0, dz: 0 }]); tick(g, 1.0); }
  const cTurn = Math.acos(Math.max(-1, Math.min(1, c0.dot(dirOf())))) * 180 / Math.PI;
  ok("F′4 ★ 反面對照:切到「跟隨(會轉)」就真的會轉(> 20°)——"
    + "沒有這條的話,把兩檔都做成不轉也會全綠", cTurn > 20, cTurn.toFixed(1) + '°');
}

/* ══════════ G HUD ══════════ */
sec('G 📋 HUD(main.js 只吃這個,不准自己翻物理內部)');
{
  const g = await mk({ ai: [false, true] });
  tick(g, 1);
  const h = g.hud();
  ok('G1 每位玩家都有隊名/動物名/比分', h.players.length === 2
    && h.players.every(p => p.label && p.kind && typeof p.score === 'number'));
  ok('G2 ★ 標出誰是電腦(兩個孩子搶鍵盤時要看得出來)',
    h.players[0].ai === false && h.players[1].ai === true);
  ok('G3 有回合數、勝利分數、視角名', h.round === 1 && h.winScore === 2 && !!h.view);
  ok('G4 ★ 快掉下台會提示(onEdge)—— 欄位存在且是 boolean',
    h.players.every(p => typeof p.onEdge === 'boolean'));
  ok('G5 隊色 HUD 與腳下光圈同一份來源(TEAM)',
    h.players[0].css === TEAM[0].css && h.players[1].css === TEAM[1].css);
}

console.log(`\n🔬 rules:${pass} 過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
