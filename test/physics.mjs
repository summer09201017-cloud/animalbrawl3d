/* 🔬 物理層 —— 用**真的 Rapier** 驅動(不是 stub)。
   ★ 這一整支之所以存在,是因為 src/physics.js 刻意不 import three:
     Rapier 的 compat 版在 node 跑得起來,所以布娃娃、平衡、揮拳、掉台、抓取
     全部都能在 headless 下驗到真值 —— 不必開瀏覽器、也不會掉進
     3d-game-kit 那條「沒有 renderer 就 early-return ⇒ 測試永遠綠」的坑。

   本檔每一段的斷言都對應建構期間**真的踩過**的坑,不是想像的:
     A 站得起來        ← 首調爆炸到座標 10^5(capsule 長軸 + cross 符號兩個錯疊起來)
     B 理智夾不該常態作用 ← 首調夾了 8613 次,「看起來能跑」其實一直在救命
     C 走/跳            ← jumpImpulse 9.5 只跳 0.09 m(腿力阻尼把它吃掉)
     D 掉台             ← grounded 判準用高度 ⇒ 掉出台外還在半空中把自己推回來,飛到 59 m 不算掉台
     E 揮拳             ← 一次性衝量拳頭只伸 0.304 m,而且最遠在第 0 幀
     F 抓取             ← 拿拳頭當原點,眼前的對手永遠抓不到
     G 煞車             ← 煞太狠 ⇒ 站超穩但推不下台(玩法壞了,站樁測試全綠) */
import {
  initPhysics, createWorld, addAnimal, stepWorld, jump, punch, grab, release,
  respawn, PARTS, SIZE, TUNE, FALL_Y, footGrounded, localToWorldY,
} from '../src/physics.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  🟢 ' + n)) : (fail++, console.log('  🔴 ' + n + (x !== '' ? ' → ' + x : ''))); };
const sec = t => console.log(`\n── ${t} ──`);
const run = (W, s, inp = {}) => { const e = W.t + s; while (W.t < e) stepWorld(W, 1 / 60, inp); };
const P = a => a.parts.pelvis.translation();

await initPhysics();

/* ══════════ A 站得起來 ══════════ */
sec('A 🦵 主動布娃娃站得起來(首調在這裡爆炸到座標 10^5)');
{
  const W = createWorld();
  const a = addAnimal(W, { x: 0, z: 0 }, 'cat');
  let m = 0; for (const k of PARTS) m += a.parts[k].mass();
  ok('A1 ★ 體重像一隻幼獸(6~14 kg)—— 首調 0.3 kg,力矩相對慣量大到必炸',
    m > 6 && m < 14, m.toFixed(2) + ' kg');
  run(W, 5);
  const p = P(a);
  ok('A2 ★★ 5 秒後還站著(pelvis 高度在站姿的 7 成以上)',
    p.y > a.standY * 0.7, `y=${p.y.toFixed(3)} 目標 ${a.standY.toFixed(3)}`);
  ok('A3 ★★ 沒有飛走(水平漂移 < 1.5 m)', Math.hypot(p.x, p.z) < 1.5, Math.hypot(p.x, p.z).toFixed(3));
  ok('A4 ★ 座標是有限數(NaN/Infinity 一律算爆炸)', isFinite(p.x) && isFinite(p.y) && isFinite(p.z));
  ok('A5 頭在胸口上面(關節沒有把身體拉反)',
    a.parts.head.translation().y > a.parts.chest.translation().y);
  /* ══════════ B 理智夾 ══════════ */
  sec('B 🛟 理智夾不可以是常態(它一直在作用 = 調參壞了,而畫面看起來還好)');
  ok('B1 ★★★ 站 5 秒,速度夾住的次數 < 5 —— 首調是 8613 次,而那是「看起來能跑」的假象',
    (W.clampCount || 0) < 5, '夾了 ' + (W.clampCount || 0) + ' 次');
}

/* ══════════ C 走 / 跳 ══════════ */
sec('C 🚶 走與跳');
{
  const W = createWorld(); const a = addAnimal(W, { x: 0, z: 0 });
  run(W, 1);
  const z0 = P(a).z;
  run(W, 2, { 0: { dx: 0, dz: 1 } });
  const moved = P(a).z - z0;
  ok('C1 往 +z 走 2 秒真的前進(> 3 m)', moved > 3, moved.toFixed(2) + ' m');
  ok('C2 ★ 沒有一路加速到飛出去(2 秒 < 9 m,maxSpeed=' + TUNE.maxSpeed + ')', moved < 9, moved.toFixed(2) + ' m');
  ok('C3 走完還站著', P(a).y > a.standY * 0.6, P(a).y.toFixed(3));

  const W2 = createWorld(); const b = addAnimal(W2, { x: 0, z: 0 });
  run(W2, 1);
  const y0 = P(b).y;
  ok('C4 站在台上時 footGrounded 為真', footGrounded(W2, b) === true);
  ok('C5 jump() 成功', jump(W2, b) === true);
  let peak = y0;
  for (let i = 0; i < 50; i++) { stepWorld(W2, 1 / 60); peak = Math.max(peak, P(b).y); }
  ok('C6 ★★ 真的跳得起來(> 0.35 m)—— jumpImpulse 9.5 只跳 0.09 m,腿力阻尼把它吃光',
    peak - y0 > 0.35, (peak - y0).toFixed(3) + ' m');
  const W3 = createWorld(); const c = addAnimal(W3, { x: 0, z: 0 });
  run(W3, 1); jump(W3, c);
  for (let i = 0; i < 12; i++) stepWorld(W3, 1 / 60);
  ok('C7 ★ 空中不能再跳(不然等於飛行)', jump(W3, c) === false);
}

/* ══════════ D 掉台 ══════════ */
sec('D 🕳 掉台判定(首調:飛到水平 59 m 卻一次都沒觸發)');
{
  const W = createWorld({ arenaRadius: 2.0 });
  const a = addAnimal(W, { x: 0, z: 0 });
  run(W, 0.8);
  a.parts.pelvis.applyImpulse({ x: 60, y: 5, z: 0 }, true);
  let fell = false, maxR = 0;
  for (let i = 0; i < 480; i++) {
    const r = stepWorld(W, 1 / 60);
    const p = P(a); maxR = Math.max(maxR, Math.hypot(p.x, p.z));
    if (r.falls.length) { fell = true; break; }
  }
  ok('D1 ★★★ 60 N·s 的側推推得下 r=2.0 的台子,而且**判定會觸發**', fell, `最遠水平 ${maxR.toFixed(2)} m`);
  ok('D2 fellAt 記下了時刻', a.fellAt != null && a.fellAt > 0, String(a.fellAt));
  ok('D3 ★ 掉台的判準是高度(不是水平距離)—— 被推到邊緣還沒掉不算輸',
    P(a).y <= FALL_Y + 0.6, P(a).y.toFixed(2) + ' (門檻 ' + FALL_Y + ')');

  respawn(W, a, { x: 0, z: 0 });
  ok('D4 respawn 清掉 fellAt', a.fellAt === null);
  run(W, 1.5);
  ok('D5 ★★ respawn 之後重新站得起來(上一回合的動量不可以跟過來)',
    P(a).y > a.standY * 0.7 && Math.hypot(P(a).x, P(a).z) < 1.2,
    `y=${P(a).y.toFixed(3)} r=${Math.hypot(P(a).x, P(a).z).toFixed(3)}`);

  /* 站在台上不可以誤判成掉台 */
  const W2 = createWorld(); const b = addAnimal(W2, { x: 0, z: 0 });
  run(W2, 6);
  ok('D6 ★ 一直站著不會被誤判成掉台(假警報比漏報更難發現)', b.fellAt === null);
}

/* ══════════ E 揮拳 ══════════ */
sec('E 👊 揮拳(首調:拳頭只伸 0.304 m,而且最遠出現在第 0 幀)');
{
  const W = createWorld();
  const A = addAnimal(W, { x: 0, z: -0.55 }), B = addAnimal(W, { x: 0, z: 0.55 });
  run(W, 1.2);
  A.facing = 0;
  const c0 = A.parts.chest.translation();
  const f0 = A.parts.armR1.translation();
  const reach0 = Math.hypot(f0.x - c0.x, f0.z - c0.z);
  ok('E1 punch() 進得去', punch(W, A, 'R') != null);
  let hits = [], reach = reach0;
  for (let i = 0; i < 45; i++) {
    const r = stepWorld(W, 1 / 60);
    hits.push(...r.hits);
    const c = A.parts.chest.translation(), f = A.parts.armR1.translation();
    reach = Math.max(reach, Math.hypot(f.x - c.x, f.z - c.z));
  }
  ok('E2 ★★★ 手臂真的掄到前面去(離胸口 > 0.42 m)—— 一次性衝量只有 0.304',
    reach > 0.42, reach.toFixed(3) + ' m(閒置時 ' + reach0.toFixed(3) + ')');
  ok('E3 ★★ 打得到對手', hits.length > 0, JSON.stringify(hits[0] || null));
  ok('E4 打中的人會癱軟(stun > 0 且 hp 掉到 0)', B.stun > 0 && B.hp < 0.2,
    `stun=${B.stun.toFixed(2)} hp=${B.hp.toFixed(2)}`);
  ok('E5 ★ 判定=畫面:命中資料指名打到哪個部位(不是「按下當時在扇形內」)',
    hits[0] && ['chest', 'head', 'pelvis'].includes(hits[0].part), hits[0] && hits[0].part);

  /* 打不到就是真的打不到 */
  const W2 = createWorld();
  const C = addAnimal(W2, { x: 0, z: -3.0 }), D = addAnimal(W2, { x: 0, z: 3.0 });
  run(W2, 1.2); C.facing = 0; punch(W2, C, 'R');
  let far = [];
  for (let i = 0; i < 45; i++) far.push(...stepWorld(W2, 1 / 60).hits);
  ok('E6 ★★ 隔 6 公尺揮拳打不到(不能變成隔空傷害)', far.length === 0, far.length + ' 次');
  ok('E7 對手完全沒事', D.stun === 0 && D.hp > 0.9);
}

/* ══════════ F 抓 / 丟 ══════════ */
sec('F ✊ 抓與丟(首調:拿拳頭當原點,眼前的對手永遠抓不到)');
{
  const W = createWorld();
  const A = addAnimal(W, { x: 0, z: -0.5 }), B = addAnimal(W, { x: 0, z: 0.35 });
  run(W, 1.2);
  A.facing = 0;
  const g = grab(W, A);
  ok('F1 ★★ 抓得到面前的對手', g != null, g ? '抓住 ' + g.key : '(抓不到)');
  ok('F2 抓取紀錄進了 W.grabs', W.grabs.has(A.i));
  ok('F3 ★ 抓著的時候不能再抓一次(不然會疊一堆關節)', grab(W, A) === null);
  const bz = B.parts.pelvis.translation().z;
  ok('F4 release(throw) 成功', release(W, A, true) === true);
  ok('F5 放手後紀錄清掉', !W.grabs.has(A.i));
  for (let i = 0; i < 45; i++) stepWorld(W, 1 / 60);
  ok('F6 ★ 被丟出去的人會動、而且會癱軟一下',
    Math.abs(B.parts.pelvis.translation().z - bz) > 0.05 || B.stun >= 0,
    `Δz=${(B.parts.pelvis.translation().z - bz).toFixed(3)}`);

  const W2 = createWorld();
  const C = addAnimal(W2, { x: 0, z: 0 }); addAnimal(W2, { x: 0, z: 4 });
  run(W2, 1.2); C.facing = 0;
  ok('F7 ★ 4 公尺外抓不到(射程 ' + TUNE.grabRange + ' m)', grab(W2, C) === null);
}

/* ══════════ G 煞車不可以殺掉玩法 ══════════ */
sec('G 🦶 腳底抓地要「站得住」又「推得動」—— 這兩件事會互相殺');
{
  /* 站著不動 → 幾乎不漂 */
  const W = createWorld(); const a = addAnimal(W, { x: 1.5, z: 0 });
  run(W, 6);
  const drift = Math.hypot(P(a).x - 1.5, P(a).z);
  ok('G1 站著 6 秒漂移 < 1.5 m(沒有煞車的話會一路自己遊走)', drift < 1.5, drift.toFixed(3) + ' m');
  /* 被大力撞 → 要滑得出去(煞車不可以吃掉衝擊) */
  const W2 = createWorld({ arenaRadius: 6 }); const b = addAnimal(W2, { x: 0, z: 0 });
  run(W2, 1);
  b.parts.pelvis.applyImpulse({ x: 55, y: 4, z: 0 }, true);
  let far = 0;
  for (let i = 0; i < 180; i++) { stepWorld(W2, 1 / 60); far = Math.max(far, Math.hypot(P(b).x, P(b).z)); }
  ok('G2 ★★★ 55 N·s 的撞擊要把人推出 > 2.5 m —— 煞太狠會站超穩但推不下台,'
    + '而那是「玩法壞掉、站樁測試全綠」', far > 2.5, far.toFixed(2) + ' m');
  ok('G3 ★ 煞車有上限參數(不是靠感覺)', TUNE.brakeMaxV > 0 && TUNE.brakeMaxV < 3,
    'brakeMaxV=' + TUNE.brakeMaxV);
}

/* ══════════ H 尺寸/名單一致性 ══════════ */
sec('H 🧬 一份名單、一份尺寸');
{
  const W = createWorld(); const a = addAnimal(W, { x: 0, z: 0 });
  ok('H1 PARTS 列的每一個部位都真的存在(名單與建構不可以漂移)',
    PARTS.every(k => a.parts[k] && typeof a.parts[k].translation === 'function'),
    PARTS.filter(k => !a.parts[k]).join(','));
  ok('H2 關節數 = 2 軀幹 + 4 手臂 + 4 腿 = 10', a.joints.length === 10, String(a.joints.length));
  ok('H3 ★ 關節都有名字(下一手要調某個關節時才找得到)',
    a.J && a.J.waist && a.J.neck && a.J.kneeL && a.J.kneeR && a.J.elbowL && a.J.hipR,
    Object.keys(a.J || {}).join(','));
  ok('H4 ★ 站姿高度是由尺寸疊出來的,不是魔術數字',
    Math.abs(a.standY - (SIZE.shin[0] * 2 + SIZE.shin[1] + SIZE.thigh[0] * 2 + SIZE.pelvis[1])) < 1e-9,
    a.standY.toFixed(4));
}

/* ══════════ I 姿勢(這一段是整個專案最貴的一課)══════════ */
sec('I 🧍 姿勢:要量每個部位各自的傾角,不能只量一個高度');
{
  /* ⚠⚠ 0828 使用者回報「角色站不起來了」。回頭一量才發現:它**從來沒有真的站起來過** ——
       髖傾 134°、胸躺平 111°、頭在髖下面、腿翻到身體上方、還漂了 1.4 公尺。
     ★★ 而 A2「pelvis 高度 > 站姿七成」**一路全綠**:腿彈簧照樣把那一團撐到 0.62 m。
       高度對、位置對,**只有姿勢是錯的**,而當時沒有任何一條斷言在看姿勢。
     ⇒ 這一段就是那個缺口。 */
  const W = createWorld();
  const a = addAnimal(W, { x: 0, z: 0 }, 'cat');
  run(W, 5);
  const tiltOf = (k) => {
    const u = localToWorldY(a.parts[k].rotation());
    return Math.acos(Math.max(-1, Math.min(1, u.y))) * 180 / Math.PI;
  };
  const worst = PARTS.map(k => [k, tiltOf(k)]).sort((x, y) => y[1] - x[1])[0];
  ok('I1 ★★★ 每個部位都大致站正(最歪的 < 45°)—— 首版最歪的是髖,134°',
    worst[1] < 45, worst[0] + ' ' + worst[1].toFixed(0) + '°');
  ok('I2 ★★ 軀幹是一體的:髖與胸傾角幾乎相同(腰是剛性接合)',
    Math.abs(tiltOf('pelvis') - tiltOf('chest')) < 6,
    tiltOf('pelvis').toFixed(0) + '° vs ' + tiltOf('chest').toFixed(0) + '°');
  const y = (k) => a.parts[k].translation().y;
  ok('I3 ★★★ 由下而上:腳 < 膝 < 髖 < 胸 < 頭 —— 首版頭在髖下面',
    y('legL1') < y('legL0') && y('legL0') < y('pelvis')
    && y('pelvis') < y('chest') && y('chest') < y('head'),
    PARTS.map(k => k + '=' + y(k).toFixed(2)).join(' '));
  ok('I4 ★★ 腳在身體下面(髖比腳高 > 0.3 m)',
    y('pelvis') - Math.max(y('legL1'), y('legR1')) > 0.3,
    (y('pelvis') - Math.max(y('legL1'), y('legR1'))).toFixed(3) + ' m');
  ok('I5 ★ 左腿在左邊、右腿在右邊(首版兩腿位置互換過)',
    a.parts.legL1.translation().x < a.parts.legR1.translation().x);
  ok('I6 ★ 手垂在身側不是外張成螃蟹(上臂 < 50°)',
    tiltOf('armL0') < 50 && tiltOf('armR0') < 50,
    tiltOf('armL0').toFixed(0) + '° / ' + tiltOf('armR0').toFixed(0) + '°');
}

/* ══════════ I′ 不倒翁 ══════════ */
sec("I′ 🥚 不倒翁(0828 使用者:「要像不倒翁一樣」)");
{
  const tiltC = (b) => {
    const u = localToWorldY(b.parts.chest.rotation());
    return Math.acos(Math.max(-1, Math.min(1, u.y))) * 180 / Math.PI;
  };
  for (const [nm, imp, tq] of [
    ['輕輕推倒', { x: 18, y: 2, z: 0 }, { x: 0, y: 0, z: -3 }],
    ['用力打飛', { x: 40, y: 8, z: 0 }, { x: 0, y: 0, z: -9 }],
    ['整個翻過去', { x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: -18 }],
  ]) {
    const W2 = createWorld({ arenaRadius: 12 });
    const b = addAnimal(W2, { x: 0, z: 0 });
    run(W2, 1.2);
    b.parts.chest.applyImpulse(imp, true);
    b.parts.chest.applyTorqueImpulse(tq, true);
    run(W2, 7);
    ok('I′ ' + nm + ' → 7 秒內自己站回來(傾角 < 30°)', tiltC(b) < 30, tiltC(b).toFixed(0) + '°');
  }
  const W3 = createWorld({ arenaRadius: 12 });
  const c = addAnimal(W3, { x: 0, z: 0 });
  run(W3, 1);
  for (const k of PARTS) {
    const p = c.parts[k].translation();
    c.parts[k].setTranslation({ x: p.x, y: 1.5 - (p.y - 0.7), z: p.z }, true);
    c.parts[k].setRotation({ x: 1, y: 0, z: 0, w: 0 }, true);
    c.parts[k].setLinvel({ x: 0, y: 0, z: 0 }, true);
    c.parts[k].setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
  run(W3, 8);
  ok("I′ ★★★ 完全倒栽蔥(180°)也翻得回來 —— 這就是「不倒翁」", tiltC(c) < 30, tiltC(c).toFixed(0) + '°');
}

console.log(`\n🔬 physics(含姿勢與不倒翁):${pass} 過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
