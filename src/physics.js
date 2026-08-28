/* ═══════════════════════════════════════════════════════════════════════════
   物理層(Rapier)—— 布娃娃動物、主動平衡、揮拳、抓取、掉台判定
   ═══════════════════════════════════════════════════════════════════════════
   ★★ 這支**刻意不 import three**。
      理由不是潔癖,是**驗證能力**:Rapier 的 compat 版在 node 跑得起來
      (實測 0.14.0:球從 y=5 落到 y=0.075),所以只要物理與規則不碰 three/DOM,
      headless 測試就能驅動**真的物理引擎**跑完整一局 —— 不是 stub、不是假 renderer。
      3d-game-kit 那條「headless 測試不會紅(沒有 renderer 就 early-return)」的坑,
      在這個專案裡是可以躲掉的,前提就是這條分界線不要被破壞。
      ⇒ 任何 `import * as THREE` 出現在本檔 = 整套物理測試當場失去意義,請不要。

   ★ 為什麼是「主動布娃娃」(active ragdoll)不是純布娃娃:
     純布娃娃站不起來(它只會癱在地上),而 Party Animals 那種手感的來源正是
     「**想站直但站不太穩**」—— 角色一直在用力對抗重力與慣性,所以走路會晃、
     被撞會踉�struggle、被打會短暫癱軟。⇒ 平衡是一個 PD 控制器,不是把角色鎖直。
     ⚠ 這也是為什麼不能用 kinematic body 移動:那會變成「推不動的冰箱」,
       撞在一起完全沒有互推的感覺,而互推就是這個遊戲的全部。
   ═══════════════════════════════════════════════════════════════════════════ */

let R = null;                       // Rapier 模組(init 之後才有)

/** 載入 Rapier WASM。瀏覽器與 node 都走這一支,只做一次。 */
export async function initPhysics() {
  if (R) return R;
  const M = await import('@dimforge/rapier3d-compat');
  R = M.default || M;
  await R.init();
  return R;
}
export const rapier = () => R;

/* ── 尺寸表(公尺)。刻意矮胖:Party Animals 的可愛感一半來自比例 ──────────
   ⚠ 這裡的比例**與 3d-figure-kit 的「長腿 v2」相反,是刻意的**:那條鐵則是給
     聖經人物/運動員(要寫實、要看得出動作);這裡要的是幼獸感 ——
     頭大、身短、腿短。改成長腿會立刻不可愛,而且重心變高、平衡更難調。 */
export const SIZE = {
  head: 0.30,                       // 半徑
  chest: [0.26, 0.20, 0.20],        // 半寬/半高/半深
  pelvis: [0.24, 0.16, 0.18],
  upperArm: [0.10, 0.09],           // [半長, 半徑](capsule)
  lowerArm: [0.10, 0.08],
  thigh: [0.11, 0.10],
  shin: [0.11, 0.09],
};
/** 布娃娃的部位順序 —— 建構、同步、測試三邊共用這一份(兩份名單遲早漂移)。*/
export const PARTS = ['pelvis', 'chest', 'head',
  'armL0', 'armL1', 'armR0', 'armR1',
  'legL0', 'legL1', 'legR0', 'legR1'];

/* 碰撞群組:同一隻動物的肢體之間**不互撞**,否則手臂會卡在自己胸口、
   平衡控制器會跟自己的手打架(首調就是這樣抖成一團)。
   Rapier 的格式是 (membership << 16) | filter。*/
const GROUND_GROUP = 1;
const groupOf = i => 1 << (i + 1);
const membershipFilter = (mem, filter) => ((mem << 16) | filter);

/** 建一個世界 + 一塊浮空平台(圓形,用多邊形柱體近似 → 邊緣才有「掉下去」的判定)*/
export function createWorld(opts = {}) {
  const arenaR = opts.arenaRadius ?? 6.0;
  const world = new R.World({ x: 0, y: -9.81 * (opts.gravityScale ?? 1), z: 0 });
  /* 平台做成扁圓柱。⚠ 用 cylinder 而不是 cuboid:方形平台的角落會讓「被推下去」
     變成「卡在角上」,而玩家會覺得是 bug 不是地形。*/
  const gBody = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.25, 0));
  const gCol = R.ColliderDesc.cylinder(0.25, arenaR).setFriction(1.1).setRestitution(0.02)
    .setCollisionGroups(membershipFilter(GROUND_GROUP, 0xFFFF));
  const groundCol = world.createCollider(gCol, gBody);
  return { world, arenaR, animals: [], grabs: new Map(), t: 0,
           ground: gBody, groundCol, groundHandle: gBody.handle };
}

/* ── 布娃娃 ─────────────────────────────────────────────────────────────── */
function box(world, i, x, y, z, half, opts = {}) {
  const d = R.RigidBodyDesc.dynamic().setTranslation(x, y, z)
    .setLinearDamping(opts.lin ?? 0.35).setAngularDamping(opts.ang ?? 1.2)
    .setCanSleep(false);                     // 睡著的布娃娃被撞不會醒得夠快 ⇒ 一律不睡
  const b = world.createRigidBody(d);
  const c = R.ColliderDesc.cuboid(half[0], half[1], half[2])
    .setDensity(opts.density ?? 45).setFriction(opts.fric ?? 0.8).setRestitution(0.02)
    .setCollisionGroups(membershipFilter(groupOf(i), 0xFFFF ^ groupOf(i)));
  world.createCollider(c, b);
  return b;
}
function ball(world, i, x, y, z, r, opts = {}) {
  const b = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x, y, z)
    .setLinearDamping(0.35).setAngularDamping(1.4).setCanSleep(false));
  world.createCollider(R.ColliderDesc.ball(r).setDensity(opts.density ?? 16)
    .setFriction(0.7).setRestitution(0.05)
    .setCollisionGroups(membershipFilter(groupOf(i), 0xFFFF ^ groupOf(i))), b);
  return b;
}
function capsule(world, i, x, y, z, hh, r, opts = {}) {
  const b = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x, y, z)
    .setLinearDamping(0.3).setAngularDamping(1.0).setCanSleep(false));
  world.createCollider(R.ColliderDesc.capsule(hh, r).setDensity(opts.density ?? 24)
    .setFriction(opts.fric ?? 0.9).setRestitution(0.02)
    .setCollisionGroups(membershipFilter(groupOf(i), 0xFFFF ^ groupOf(i))), b);
  return b;
}
const V = (x, y, z) => ({ x, y, z });

/**
 * 造一隻布娃娃動物。
 * @param {object} W createWorld() 的回傳
 * @param {{x:number,z:number}} at 落地點
 * @param {string} kind 'cat' | 'dog' | 'bunny' | 'duck'(只影響視覺與微調的體重)
 */
export function addAnimal(W, at, kind = 'cat') {
  const { world } = W;
  const i = W.animals.length;
  const x0 = at.x, z0 = at.z;
  const S = SIZE;
  /* 站姿高度由下往上疊出來,不要各寫一個魔術數字 —— 改一處尺寸別處會自己跟上。*/
  const yShin = S.shin[0] + S.shin[1];
  const yThigh = yShin + S.shin[0] + S.thigh[0];
  const yPelvis = yThigh + S.thigh[0] + S.pelvis[1];
  const yChest = yPelvis + S.pelvis[1] + S.chest[1];
  const yHead = yChest + S.chest[1] + S.head;
  const dxLeg = 0.13, dxArm = S.chest[0] + S.upperArm[1];

  const P = {};
  /* 🥚 不倒翁的原理是**重心壓在底部**:髖很重、頭很輕 ⇒ 重力自己會把它扶正,
     扶正力矩只要幫個忙,不必硬把整隻扳回來。
     ⚠ 0828 使用者:「角色站不起來了,要像不倒翁一樣」。首版三個密度差不多,
       重心落在胸口附近 ⇒ 一倒下去重力沒有理由把它扶回來,只能靠力矩硬扳,
       而力矩扳不動的時候它就**歪在那裡不動了**(實測傾角 84°~111° 停住)。
     ★ 頭輕還有第二個好處:被打的時候頭甩得更誇張(那是這型遊戲的笑點)。*/
  P.pelvis = box(world, i, x0, yPelvis, z0, S.pelvis, { density: 130 });
  P.chest = box(world, i, x0, yChest, z0, S.chest, { density: 22 });
  P.head = ball(world, i, x0, yHead, z0, S.head, { density: 7 });
  /* ⚠⚠ Rapier 的 capsule(halfHeight, radius) **長軸是 Y**。
     首建時我把手臂當成 X 軸橫擺,錨點就落在膠囊的**側面**而不是端點 ⇒
     每個肩關節都變成一根長槓桿,兩幀之內整隻動物炸到座標 10^5(實測 pelvis y=-385140)。
     ⇒ 手臂一律從肩膀**往下垂**(Y 軸),錨點放端點 (0, ±halfLen, 0)。
     順便:下垂也才是可愛動物該有的閒置姿勢(3d-game-kit §1:閒置姿勢不可擋臉)。*/
  const yShoulder = yChest + S.chest[1] * 0.3;
  for (const [side, sx] of [['L', -1], ['R', 1]]) {
    const xArm = x0 + sx * dxArm;
    P['arm' + side + '0'] = capsule(world, i, xArm, yShoulder - S.upperArm[0], z0, S.upperArm[0], S.upperArm[1]);
    P['arm' + side + '1'] = capsule(world, i, xArm, yShoulder - S.upperArm[0] * 2 - S.lowerArm[0], z0, S.lowerArm[0], S.lowerArm[1]);
    P['leg' + side + '0'] = capsule(world, i, x0 + sx * dxLeg, yThigh, z0, S.thigh[0], S.thigh[1]);
    P['leg' + side + '1'] = capsule(world, i, x0 + sx * dxLeg, yShin, z0, S.shin[0], S.shin[1], { fric: 1.4 });
  }

  /* 關節。★ 用 spherical(球窩)給軀幹與肩髖 = 可以往任何方向倒(那是「不穩」的來源);
     肘膝用 revolute 限成單軸,不然手腳會反折成不可愛的樣子。
     ⚠ Rapier 的 anchor 是**各自剛體的本地座標**,不是世界座標 —— 寫成世界座標的話
       角色一生出來就會被關節硬拉成一團(首建就踩到)。*/
  const J = [], named = {};
  const sph = (n, a, b, aa, ab) => {
    const j = world.createImpulseJoint(R.JointData.spherical(aa, ab), a, b, true);
    J.push(j); named[n] = j; return j;
  };
  /* revolute 一律**設限位**:不限的話肘膝會反折成不可愛的樣子,而那不會亮任何紅燈 ——
     只有真的把畫面看一眼才發現(3d-game-kit 那條 visible-strict 同族的「只有眼睛抓得到」)。*/
  const rev = (n, a, b, aa, ab, ax, lim) => {
    const j = world.createImpulseJoint(R.JointData.revolute(aa, ab, ax), a, b, true);
    if (lim) j.setLimits(lim[0], lim[1]);
    J.push(j); named[n] = j; return j;
  };
  /* 🧱 腰改成**剛性接合**,軀幹是一體的。
     ⚠⚠ 這是改結構,不是調參數 —— 而且是在轉了三輪旋鈕之後才想到的:
       髖與胸原本各自是一顆會被扶正的剛體,**兩顆在互相打架**;
       再加上四肢扶正的反作用力也全灌在髖上,結果是「前 10 幀正常,第 20~40 幀炸開」,
       之後整隻在 28°~69° 之間亂晃,怎麼調增益都只是換一種晃法。
     ★ 不倒翁的本體本來就該是**一顆有重量的整體**,不是兩節互相角力的積木。
       布娃娃的滑稽感留給四肢與頭 —— 那才是玩家在看的地方。*/
  J.push(world.createImpulseJoint(
    R.JointData.fixed(V(0, S.pelvis[1], 0), { x: 0, y: 0, z: 0, w: 1 },
                      V(0, -S.chest[1], 0), { x: 0, y: 0, z: 0, w: 1 }),
    P.pelvis, P.chest, true));
  named.waist = J[J.length - 1];
  /* 🧠 脖子用**帶限位的 revolute**,不是球窩。
     ⚠⚠ 這是改結構、不是調參數:球窩在 Rapier 沒有角度限位,頭可以繞著頸點盪到胸口
       旁邊甚至下方,而那個姿勢**完全滿足關節約束**(不會有任何錯誤)。
       我先加力矩(只改朝向、改不了位置)、再加位置彈簧(注入動量,身體被推著漂
       2.69 m)、再補反作用力,最後做了 6 組參數掃描 —— **每一組都有一項紅**,
       因為問題從頭到尾不在參數。
     ★ 代價講清楚:頭只能點頭(繞 X),不能左右歪 ⇒ 少一點布娃娃的滑稽,
       換到「頭永遠在該在的地方」。以可愛動物來說這個交換是對的。*/
  rev('neck', P.chest, P.head, V(0, S.chest[1], 0), V(0, -S.head, 0), V(1, 0, 0), [-0.5, 0.5]);
  for (const [side, sx] of [['L', -1], ['R', 1]]) {
    sph('shoulder' + side, P.chest, P['arm' + side + '0'], V(sx * dxArm, S.chest[1] * 0.3, 0), V(0, S.upperArm[0], 0));
    rev('elbow' + side, P['arm' + side + '0'], P['arm' + side + '1'],
      V(0, -S.upperArm[0], 0), V(0, S.lowerArm[0], 0), V(1, 0, 0), [-2.0, 0.05]);
    sph('hip' + side, P.pelvis, P['leg' + side + '0'], V(sx * dxLeg, -S.pelvis[1], 0), V(0, S.thigh[0], 0));
    const knee = rev('knee' + side, P['leg' + side + '0'], P['leg' + side + '1'],
      V(0, -S.thigh[0], 0), V(0, S.shin[0], 0), V(1, 0, 0), [-0.05, 2.0]);
    /* 🦵 膝馬達:目標角度 0 = 打直。這是「站得起來」的一半 ——
       只靠胸口的平衡力矩,膝蓋會慢慢垮掉(首調實測 pelvis 從 0.69 沉到 0.23)。*/
    knee.configureMotorPosition(0, TUNE.kneeStiff, TUNE.kneeDamp);
  }

  const a = {
    i, kind, parts: P, joints: J, J: named,
    hp: 1,                 // 1=清醒、0=完全癱軟(被打會掉,會自己回復)
    stun: 0,               // 剩餘癱軟秒數
    facing: 0,             // 目前朝向(弧度),由移動輸入推
    score: 0,
    fellAt: null,          // 掉台的時刻(秒),null=還在台上
    standY: yPelvis,       // 站立時 pelvis 的高度(平衡控制器的目標)
    cd: { punch: 0, jump: 0 },
  };
  W.animals.push(a);
  return a;
}

/* ── 控制:走、跳、平衡 ──────────────────────────────────────────────────── */
/* 力道全部按「一隻約 9 公斤的幼獸」重算過。
   ⚠ 首調用的是 0.3 公斤版的數字 ⇒ 力矩相對慣量大到必炸,理智夾一路夾了 8613 次
     才勉強沒有飛走 —— 那正是「看起來能跑」的假象。
     ★ 所以理智夾要**可計數**:夾了幾次是一個可以斷言的東西,
       靜靜地夾住不出聲的話,這個坑會一直留在專案裡。*/
export const TUNE = {
  moveForce: 62,        // 走路推力(一半給髖、各 1/4 給兩隻小腿,見 control)
  moveTipComp: 1.4,    // 翻倒力矩抵銷幾成(1=完全抵銷=推不倒的冰箱,那就沒有踉蹌感了)
  maxSpeed: 3.4,
  /* 扶正:uprightK 是「站著時輕輕扶」的力(越大越挺,太大會變成鎖直的機器人);
     getUpBoost 是「倒了之後加碼多少」—— 不倒翁的個性就調這個。*/
  uprightK: 11, getUpBoost: 5.5,
  /* 🔧 積分項:治「固定歪 11° 不回正」。
     ⚠⚠ 病根量出來了:歪的方向**永遠是世界座標 −z,跟角色朝哪無關** ——
       所以不是身體自己的力,是一股固定的干擾。把膝關節限位翻過來,歪的方向也跟著翻
       ⇒ 真兇是**膝馬達的穩態誤差**(馬達目標 0,重力壓著它,P 控制永遠差一點)。
     ★ 這是課本題:P 控制器碰到固定干擾**必然有穩態誤差**,解法是加積分項,
       不是把 P 調大 —— 實測把 uprightK 從 11 拉到 40,歪的角度是變小了,
       但擺幅從 0.026 m 爆到 2.02 m(整隻在彈跳)。**調大 P 是在拿震盪換誤差。**
     ⚠ 防積分飽和:①限幅 ②被打癱/大角度翻倒時歸零(那時候要的是快速翻正,
       不是慢慢累積的微調;不歸零的話爬起來會過衝)。*/
  uprightI: 0, uprightIMax: 0.42,
  uprightD: 2.6,        // 平衡 D 項(阻尼,太小會抖)
  faceK: 3.4,           // 轉向力矩
  /* 🦵 腿力:把身體撐到站立高度的 PD 彈簧。**只准往上推,不准往下拉** ——
     腿可以蹬地,不能把自己吸向地面(允許負值的話跳起來會被硬拉回去)。*/
  legK: 1900, legD: 110,
  /* 🦶 腳底抓地:沒有輸入又踩在台上時,把水平速度煞掉。
     ⚠ 不加這個的話,胸口的平衡力矩會經腰關節反作用到 pelvis,角色會**自己慢慢遊走**
       (實測 600 幀漂 1.86 m,而且沒有停下來的意思)—— 看起來像「站不住」的 bug。
     ★ 但**不要煞到零**:完全不滑就沒有被推的手感了,而互推是這個遊戲的全部。*/
  brake: 46, brakeMaxV: 1.3,
  /* 🦵 膝馬達要夠硬,不然往前走的時候膝蓋會被前傾的力壓垮
     (實測走完 pelvis 只剩 0.387,站姿是 0.690 = 蹲著走)。*/
  kneeStiff: 110, kneeDamp: 9,
  /* 🧠 脖子:球窩關節在 Rapier 沒有限位,不扶的話頭會垂下來 —— 而垂著頭的可愛動物
     看起來像死掉的。⚠ 這條不會亮任何紅燈(座標有限、沒有 NaN、還站得住),
     只有斷言「頭在胸口上面」才抓得到(test/physics.mjs A5 首跑就是紅的)。*/
  neckK: 3.2, neckD: 0.55, neckLift: 190, neckLiftD: 16,
  /* 🦴 四肢姿勢:髖與肩是**球窩關節,Rapier 沒有馬達也沒有限位** ——
     不主動扶的話手腳會外張成螃蟹,而軀幹還是「站著」的高度。
     ⚠⚠ 這是本專案最貴的一課:我的斷言只量「pelvis 高度 > 站姿七成」,
       所以一團縮著的、腿翻到身上的、胸口躺平 111° 的角色,**測試一路全綠**——
       因為腿彈簧照樣把那一團撐到 0.62 m。使用者一玩就看出來:「角色站不起來了」。
     ⇒ 姿勢要靠**每個部位各自的傾角**驗,不能只量一個高度(test physics.mjs I 段)。
     ★ 腿比手用力(腿要撐住身體;手鬆一點才會晃、才好笑)。*/
  /* 單位是 rad/s² per rad(已按各肢慣量換算,見 alignLimb)*/
  limbLegK: 500, limbLegD: 33,
  limbArmK: 260, limbArmD: 26,
  jumpImpulse: 20,   // 實測 20×2 顆 ≈ 跳 0.73 m(9.5 只跳 0.09,腿力阻尼把它吃掉了)
  punchImpulse: 190,   // 持續施力版(N),不是一次性衝量
  punchStun: 0.75,      // 被打中癱軟幾秒
  grabRange: 0.8, grabAhead: 0.45,
  recover: 0.55,        // 每秒回復多少 hp
};

/**
 * 🦶 腳有沒有踩在台子上 —— **用往下的射線問物理引擎**,不要用「腳的 y 很低」當判準。
 * ⚠⚠ 這是首調踩到、而且症狀完全誤導的一個 bug:
 *   原本寫 `footY < 0.48` 當 grounded。角色被推出台外**往虛空掉下去**的時候,
 *   footY 是一個很負的數 ⇒ 條件照樣成立 ⇒ 腿彈簧看到 `standY - py` 是個大正數,
 *   於是**在半空中用盡全力把自己往上推**,角色一路彈回來、永遠掉不下去。
 *   實測:側推 200 N·s 飛到水平 59 公尺,掉台判定**一次都沒觸發**。
 *   ★ 那個畫面看起來像「掉台判定壞了」,而壞的其實是腳有沒有著地的判準 ——
 *     往錯的地方查會查很久。
 * ⇒ 改成射線:從腳往下打一條短射線,命中的必須**是台子那顆剛體**。
 *   台子外面沒有東西可以命中 ⇒ 自然就不會施力,也就自然掉得下去。
 *   ★ 好處不只是對:它讓「站在台上」變成一件**問得到答案**的事,測試可以直接斷言。
 */
export function footGrounded(W, a) {
  const R2 = R;
  const reach = SIZE.shin[1] + 0.22;          // 腳底再往下探一點點(容許壓縮)
  for (const key of ['legL1', 'legR1']) {
    const t = a.parts[key].translation();
    const ray = new R2.Ray({ x: t.x, y: t.y, z: t.z }, { x: 0, y: -1, z: 0 });
    /* ⚠ 射線起點在小腿膠囊**內部**,solid=true 時第一個命中就是自己的腿(toi=0)
       ⇒ 永遠判成「沒踩到台子」,角色一路垮到 y=0.166(實測)。
       ⇒ 用碰撞群組把自己排除:射線只跟「台子」那個群組互動。
         Rapier 的 filterGroups 也是 (membership << 16) | filter,
         filter 設成 GROUND_GROUP ⇒ 動物肢體的 membership(1<<(i+1))與它交集為 0,自然被跳過。*/
    const hit = W.world.castRay(ray, SIZE.shin[0] + reach, true,
      undefined, membershipFilter(0xFFFF, GROUND_GROUP));
    if (hit && hit.collider && hit.collider.parent()
        && hit.collider.parent().handle === W.groundHandle) return true;
  }
  return false;
}

/** 平衡控制器:讓角色「想站直」。stun 期間刻意不施力 ⇒ 那就是被打癱的樣子。*/
function applyUpright(W, a, dt) {
  const chest = a.parts.chest;
  if (a.hp <= 0.02) return;
  const q = chest.rotation();
  /* 把本地 +y 轉到世界,量它離真正的上有多遠;叉積就是「要繞哪個軸轉才會扶正」。
     ⚠⚠ cross(up, (0,1,0)) 展開 = (-up.z, 0, up.x)。
       首建時我寫成 (up.z, 0, -up.x) —— **整個符號反了**,於是力矩把角色往
       它正在倒的方向再推一把 = 正回饋,兩幀就炸到 10^5。
       ★ 這種錯不會拋例外、不會進 console,只會讓角色「一出生就飛走」——
         而那個症狀看起來像關節設定壞掉,很容易往錯的地方查。*/
  const up = localToWorldY(q);
  /* ⚠⚠ 首版直接拿 cross 的分量當誤差,而 |cross(up, ŷ)| = sin(傾角):
     傾角 90° 時最大,**過了 90° 反而愈躺平愈小**,180°(完全倒栽)時是 0 ——
     也就是「倒得愈徹底,想爬起來的力愈小」,那正好是反的。
     ⇒ 改成:方向取正規化的旋轉軸,大小取**真正的夾角**(acos),
       這樣 180° 也有滿滿的扶正力。
     ★ 而且傾角越大越加碼(getUp):站著時輕輕扶(才會晃、才好笑),
       真的倒了就用力爬起來(那是使用者要的不倒翁)。*/
  const ang = Math.acos(Math.max(-1, Math.min(1, up.y)));      // 0=站直,π=倒栽
  const axLen = Math.hypot(up.z, up.x) || 1e-6;
  const axX = -up.z / axLen, axZ = up.x / axLen;
  const getUp = 1 + TUNE.getUpBoost * (ang / Math.PI);          // 越倒越用力
  /* 積分:只在「快站直了」的小角度區間累積 —— 大角度時要的是翻正不是微調 */
  if (ang < 0.45 && a.hp > 0.5) {
    a.iX = (a.iX || 0) + axX * ang * dt;
    a.iZ = (a.iZ || 0) + axZ * ang * dt;
    const im = Math.hypot(a.iX, a.iZ);
    if (im > TUNE.uprightIMax) { a.iX *= TUNE.uprightIMax / im; a.iZ *= TUNE.uprightIMax / im; }
  } else { a.iX = 0; a.iZ = 0; }                      // 防飽和:倒了就歸零
  const w = chest.angvel();
  const k = TUNE.uprightK * a.hp * getUp, d = TUNE.uprightD * a.hp;
  const ki = TUNE.uprightI * a.hp;
  chest.applyTorqueImpulse(V(
    (axX * ang * k + a.iX * ki - w.x * d) * dt,
    -w.y * d * 0.35 * dt,
    (axZ * ang * k + a.iZ * ki - w.z * d) * dt), true);
  /* 髖也要一起扶 —— 只扶胸口的話,腰會被扭成 S 形而下半身還躺著。
     ⚠⚠ 但必須用**髖自己的**誤差,不可以拿胸口的誤差去轉髖。
       首版就是拿 axX/axZ/ang(胸口算出來的)直接施在 pelvis 上 ⇒
       髖被轉到一個跟它自己姿勢無關的方向,實測**髖傾 147°(幾乎上下顛倒)**、
       兩條腿翻到髖旁邊、左右腿還互換了位置 —— 整隻縮成一團被腿彈簧撐在半空。
     ★★ 而「站得住」的斷言只量 pelvis 高度,所以**一路全綠**:
       腿彈簧照樣把那一團撐到 0.62 m,高度完全正確、姿勢完全錯誤。
       這就是使用者說的「角色站不起來了」——
       ⇒ 教訓:姿勢類的驗收要量**每個部位各自的傾角**,不能只量一個高度。*/
  /* 腰是 fixed joint ⇒ 髖跟著胸走,**不要再單獨扶髖** ——
     兩個扶正器對同一塊剛體施力就是自己跟自己打架(那正是上一版的病)。*/

  /* 🧠 脖子:把頭扶正(同一支 PD,力道小很多 —— 太大會變成僵硬的機器人頭)。*/
  const head = a.parts.head;
  {
    const hq = head.rotation();
    const hu = localToWorldY(hq);
    const hw = head.angvel();
    const hk = TUNE.neckK * a.hp, hd = TUNE.neckD * a.hp;
    const tqx = (-hu.z * hk - hw.x * hd) * dt;
    const tqy = -hw.y * hd * 0.3 * dt;
    const tqz = (hu.x * hk - hw.z * hd) * dt;
    head.applyTorqueImpulse(V(tqx, tqy, tqz), true);
    chest.applyTorqueImpulse(V(-tqx, -tqy, -tqz), true);   // 同上:成對才不注入角動量
    /* ⚠⚠ 只給力矩**扶不起頭**:球窩關節允許頭繞著頸點盪到胸口旁邊甚至下面,
       而那個姿勢完全滿足關節約束(所以不會有任何錯誤)。力矩只改頭的**朝向**,
       改不了它在哪裡。⇒ 還要一條**位置**彈簧,把頭拉回「胸口正上方」那一點。
       ★ 這是「約束成立 ≠ 姿勢正確」的活例:座標有限、沒有 NaN、人還站得住,
         只有斷言「頭在胸口上面」才抓得到(test A5 首跑就是紅的,補了力矩還是紅)。*/
    const cq = chest.rotation();
    const cu = localToWorldY(cq);                    // 胸口的本地上方 → 頭該待的方向
    const cp = chest.translation(), hp = head.translation();
    const wantY = SIZE.chest[1] + SIZE.head;
    const tx = cp.x + cu.x * wantY, ty = cp.y + cu.y * wantY, tz = cp.z + cu.z * wantY;
    const hv = head.linvel();
    /* ⚠⚠ **反作用力一定要施回胸口**。首版只推頭 ⇒ 那是在對整個系統注入動量
       (不是肌肉,是外力)⇒ 角色被自己的脖子推著跑,站 6 秒漂 2.69 m。
       ★ 症狀是「站不住」,而真兇是「少了一半的牛頓第三定律」——
         往平衡參數去調會愈調愈糟(我差點就去加大煞車,那會把玩法一起殺掉)。
       ⇒ 凡是「身體自己出的力」(扶頭、扶正、掄拳)都要成對,系統總動量才不變。*/
    const ix = ((tx - hp.x) * TUNE.neckLift - hv.x * TUNE.neckLiftD) * dt;
    const iy = ((ty - hp.y) * TUNE.neckLift - hv.y * TUNE.neckLiftD) * dt;
    const iz = ((tz - hp.z) * TUNE.neckLift - hv.z * TUNE.neckLiftD) * dt;
    head.applyImpulse(V(ix, iy, iz), true);
    chest.applyImpulse(V(-ix, -iy, -iz), true);
  }

  /* 🦴 四肢扶正:讓大腿/小腿/上臂/前臂的本地 +y 對齊世界上方
     = 腿垂在身體下面、手垂在身側(它們建構時就是這個朝向)。
     ★ 反作用力施回**父節點**,總角動量才不變(同抬頭彈簧那條:
       只推一邊 = 對系統注入動量,角色會被自己的手腳推著跑)。*/
  /* ⚠⚠ 增益要**按各肢自己的慣量換算**,不可以拿一組數字套所有部位。
     這個坑在本專案犯了兩次:第一次把胸口(慣量約 0.08)調好的 26 直接用在大腿
     (慣量約 0.001,**差 80 倍**)⇒ 角加速度 430 rad/s²,「前 10 幀正常、第 20~40 幀炸開」;
     調小之後還是有 51 次速度被理智夾住(小腿頂到 40 rad/s)。
     ⇒ 現在乘上 I ≈ m·L²·0.4,kk 的單位就變成「rad/s² per rad」——
       與部位大小無關,換尺寸也不必重調。★ 理智夾的次數就是這件事有沒有做對的溫度計。*/
  const alignLimb = (child, parent, kk, dd, len) => {
    const cu = localToWorldY(child.rotation());
    const cAng = Math.acos(Math.max(-1, Math.min(1, cu.y)));
    if (cAng < 1e-4) return;
    const cl = Math.hypot(cu.z, cu.x) || 1e-6;
    const cw = child.angvel();
    const I = child.mass() * len * len * 0.4;
    const tx = I * (-cu.z / cl * cAng * kk - cw.x * dd) * a.hp * dt;
    const tz = I * (cu.x / cl * cAng * kk - cw.z * dd) * a.hp * dt;
    child.applyTorqueImpulse(V(tx, 0, tz), true);
    parent.applyTorqueImpulse(V(-tx, 0, -tz), true);
  };
  for (const side of ['L', 'R']) {
    alignLimb(a.parts['leg' + side + '0'], a.parts.pelvis, TUNE.limbLegK, TUNE.limbLegD, SIZE.thigh[0]);
    alignLimb(a.parts['leg' + side + '1'], a.parts['leg' + side + '0'], TUNE.limbLegK * 0.7, TUNE.limbLegD * 0.7, SIZE.shin[0]);
    alignLimb(a.parts['arm' + side + '0'], chest, TUNE.limbArmK, TUNE.limbArmD, SIZE.upperArm[0]);
    alignLimb(a.parts['arm' + side + '1'], a.parts['arm' + side + '0'], TUNE.limbArmK * 0.6, TUNE.limbArmD * 0.6, SIZE.lowerArm[0]);
  }

  /* 🦵 腿力(站起來的另一半):pelvis 的高度 PD。
     ★ 為什麼不是把 pelvis 的 y 直接設好:那會變成「浮在空中的冰箱」——
       被推的時候沒有反作用力、掉台也掉不下去,而互推與掉台就是這個遊戲的全部。
     ⚠ 夾成 >= 0:腿只能蹬,不能吸(允許負值時跳起來會被自己拉回地面)。
     ⚠ 腳離地時不施力(在空中還撐 = 空中踩空氣往上飛)。*/
  const pelvis = a.parts.pelvis;
  /* 跳起來的頭 0.3 秒不施腿力:legD 的阻尼會把往上的速度吃掉,
     不關掉的話按跳只會「蹲一下」(首調實測只跳 0.09 m)。*/
  const grounded = a.airT <= 0 && footGrounded(W, a);
  if (grounded) {
    /* ⚠⚠ 腿力要**隨傾角收掉**。首版不管身體歪成什麼樣都照撐 ⇒
       角色躺著卻被垂直的腿力頂在半空,實測「pelvis 高度接近站姿、傾角卻 105°」——
       看起來像浮著的怪姿勢,而且那股力**正好抵銷扶正力矩**,於是它永遠卡在那裡。
       ★ 這是最誤導的一種:高度是對的、位置是對的,只有姿勢是錯的,
         而「站得住」的斷言(量高度)完全看不出來。
       ⇒ cos(傾角) 當係數:站直全力撐,躺平不撐(讓它先滾正,再撐起來)。*/
    const lean = Math.max(0, Math.cos(ang));
    const py = pelvis.translation().y, pv = pelvis.linvel().y;
    const f = Math.max(0, (a.standY - py) * TUNE.legK - pv * TUNE.legD) * a.hp * lean;
    pelvis.applyImpulse(V(0, f * dt, 0), true);
  }
}
/** 本地 +y 軸轉到世界座標(不引 three,自己展開四元數旋轉)*/
export function localToWorldY(q) {
  const { x, y, z, w } = q;
  return { x: 2 * (x * y + w * z), y: 1 - 2 * (x * x + z * z), z: 2 * (y * z - w * x) };
}

/** 一幀的角色控制。dir 是世界座標的移動方向(不必正規化,內部處理)*/
export function control(W, a, dt, input) {
  a.cd.punch = Math.max(0, a.cd.punch - dt);
  a.cd.jump = Math.max(0, a.cd.jump - dt);
  if (a.stun > 0) { a.stun -= dt; if (a.stun < 0) a.stun = 0; }
  a.hp = a.stun > 0 ? 0 : Math.min(1, a.hp + TUNE.recover * dt);

  a.airT = Math.max(0, (a.airT || 0) - dt);
  applyUpright(W, a, dt);
  driveSwing(a, dt);
  const pelvis = a.parts.pelvis;
  let dx = input?.dx || 0, dz = input?.dz || 0;
  const len = Math.hypot(dx, dz);
  if (len > 1e-4 && a.hp > 0.25) {
    dx /= len; dz /= len;
    a.facing = Math.atan2(dx, dz);
    const v = pelvis.linvel();
    const sp = Math.hypot(v.x, v.z);
    /* 到了最高速就不再加力 —— 不然按住方向鍵會一路加速到飛出去。*/
    const f = sp < TUNE.maxSpeed ? TUNE.moveForce * a.hp : 0;
    /* ⚠⚠ 移動的力要**分給腳**,不能全推在髖上。
       腰改成剛性接合之後,推髖 = 推整個軀幹,而腳還留在後面 ⇒
       軀幹繞著腳往前翻,實測走 1.5 秒就撲倒到 101°(而且它會自己爬起來再撲一次)。
       ★ 症狀是「走一走就趴下去」,很容易被當成平衡沒調好去加大扶正力 ——
         但那治不了,因為問題是**力施加的位置**不是力的大小。
       ⇒ 腳先走、身體跟上:一半的力給兩隻小腿,髖只拿一半。*/
    pelvis.applyImpulse(V(dx * f * 0.5 * dt, 0, dz * f * 0.5 * dt), true);
    for (const key of ['legL1', 'legR1']) {
      a.parts[key].applyImpulse(V(dx * f * 0.25 * dt, 0, dz * f * 0.25 * dt), true);
    }
    /* 🧮 抵銷「推力造成的翻倒力矩」——**這是物理不是參數**,所以要算不要調。
       水平推力施在重心、支撐點在腳底 ⇒ 對接觸點必然產生 τ = r × F 的翻倒力矩
       (r = 腳底到重心的向量)。不抵銷的話走一走就往前撲,實測走 1.5 秒趴到 101°;
       而那個症狀看起來像「平衡沒調好」,往加大扶正力去調**治不了** ——
       力矩來自力施加的位置,不是力的大小。
       r × F 的符號**首版寫反了**,結果最大傾角 116°(比不抵銷還糟);
       反過來之後 57°。⇒ 這種「加了反而更糟」就是符號的味道,先翻符號再調大小。
       ⚠ 只抵銷一部分(compFrac):全抵銷會變成「推不倒的冰箱」,
         而「推來推去會踉蹌」正是這個遊戲要的。*/
    const hCom = Math.max(0.1, pelvis.translation().y - SIZE.shin[1]);
    const Fx = dx * f, Fz = dz * f, c = TUNE.moveTipComp * hCom * dt;
    pelvis.applyTorqueImpulse(V(Fz * c, 0, -Fx * c), true);
  }
  else if (a.hp > 0.25) {
    /* 🦶 沒有輸入 ⇒ 腳底抓地(見 TUNE.brake)。只在真的踩著台子時煞,
       不然會變成「在空中也能停住」。*/
    if (footGrounded(W, a)) {
      const v = pelvis.linvel();
      /* ⚠⚠ 煞車**只在低速時作用**。首調沒設上限,結果 60 N·s 的側推在 r=2.0 的台子上
         推不下去(實測水平只跑到 1.2 m 就停了)—— 而「被推下台」就是這個遊戲的全部,
         煞太狠等於把遊戲關掉。★ 這種壞法很陰:角色站得超穩、看起來品質很好,
         壞掉的是玩法而不是畫面,而站樁測試永遠是綠的。
         ⇒ 只煞「自己晃出來的那點速度」,大力撞擊照樣把你送出台外。*/
      const sp = Math.hypot(v.x, v.z);
      if (sp < TUNE.brakeMaxV) {
        pelvis.applyImpulse(V(-v.x * TUNE.brake * dt, 0, -v.z * TUNE.brake * dt), true);
      }
    }
  }

  /* 轉向:把身體轉到 facing。用力矩不用直接設角度 —— 設角度會讓互推失去反作用力。*/
  if (a.hp > 0.25) {
    const q = pelvis.rotation();
    const cur = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
    let e = a.facing - cur;
    while (e > Math.PI) e -= 2 * Math.PI;
    while (e < -Math.PI) e += 2 * Math.PI;
    const w = pelvis.angvel();
    pelvis.applyTorqueImpulse(V(0, (e * TUNE.faceK - w.y * 1.1) * a.hp * dt, 0), true);
  }
}

/** 跳。★ 只有腳「大致踩著地」才能跳(不然空中連跳=飛行)*/
export function jump(W, a) {
  if (a.cd.jump > 0 || a.hp < 0.6) return false;
  if (!footGrounded(W, a)) return false;          // 在空中不能再跳(不然等於飛行)
  a.cd.jump = 0.45;
  a.airT = 0.3;                                   // 這段時間不施腿力,見 applyUpright
  for (const p of ['pelvis', 'chest']) a.parts[p].applyImpulse(V(0, TUNE.jumpImpulse, 0), true);
  return true;
}

/**
 * 揮拳。★ 判定=畫面(3d-game-kit 鐵則 4):傷害結算在**手的世界座標**離對手多近,
 * 不是「按下的當下對手在不在扇形內」。所以打不到就是真的打不到,玩家看到的與判定同一件事。
 * ⚠ 同族的前科:weapon-arm-guard(#45)—— 動畫動右手、判定卻算左手,血掉了拳頭還沒到。
 *   這裡只有一份來源:拳頭那顆剛體的位置。
 */
export function punch(W, a, hand = 'R') {
  if (a.cd.punch > 0 || a.hp < 0.5) return null;
  a.cd.punch = 0.5;
  a.punchHand = hand;
  return { hand };
}

/**
 * 每幀把揮擊中的手臂**持續**往前掄。
 * ⚠⚠ 首版是「按下時給拳頭一發衝量」——實測拳頭離胸口最遠只有 0.304 m,
 *   而且**最遠出現在第 0 幀**:一發衝量瞬間就被肩關節與手臂慣量吃光,手根本沒有伸出去,
 *   於是兩隻動物要靠到胸口相距 0.72 m 以內才打得到 = 玩起來像「必須貼著才有拳」。
 *   ⇒ 改成在揮擊窗內**每幀施力**:手臂真的掄到前面,玩家看到的與判定同一件事
 *     (3d-game-kit 鐵則 4「判定=畫面」;#45 weapon-arm-guard 那條的同族)。
 * ★ 上臂也要施力,只推小臂的話肘關節會把力吃掉、手只會軟軟地盪。
 */
function driveSwing(a, dt) {
  const hand = a.punchHand;
  if (!hand || a.cd.punch <= 0.1) { a.punchHand = null; return; }
  const f = { x: Math.sin(a.facing), z: Math.cos(a.facing) };
  const up = a.parts['arm' + hand + '0'], lo = a.parts['arm' + hand + '1'];
  const k = TUNE.punchImpulse;
  up.applyImpulse(V(f.x * k * 0.5 * dt, k * 0.35 * dt, f.z * k * 0.5 * dt), true);
  lo.applyImpulse(V(f.x * k * dt, k * 0.30 * dt, f.z * k * dt), true);
  a.parts.chest.applyImpulse(V(-f.x * k * 0.12 * dt, 0, -f.z * k * 0.12 * dt), true);   // 反作用力
}

/** 拳頭有沒有打到別人 —— 每幀查一次(位置驅動,不是按鍵驅動)*/
export function resolveHits(W, dt) {
  const out = [];
  for (const a of W.animals) {
    if (a.cd.punch < 0.18 || a.cd.punch > 0.42) continue;   // 只在揮擊中段有判定
    for (const hand of ['L', 'R']) {
      const fist = a.parts['arm' + hand + '1'].translation();
      for (const b of W.animals) {
        if (b === a || b.stun > 0.35) continue;
        for (const key of ['chest', 'head', 'pelvis']) {
          const t = b.parts[key].translation();
          const d = Math.hypot(fist.x - t.x, fist.y - t.y, fist.z - t.z);
          if (d > 0.42) continue;
          const dir = { x: t.x - fist.x, z: t.z - fist.z };
          const L = Math.hypot(dir.x, dir.z) || 1;
          const p = key === 'head' ? 1.35 : 1;              // 打頭比較痛(也比較好笑)
          b.parts[key].applyImpulse(V(dir.x / L * 5.4 * p, 2.2 * p, dir.z / L * 5.4 * p), true);
          b.stun = Math.max(b.stun, TUNE.punchStun * p);
          b.hp = 0;
          out.push({ by: a.i, on: b.i, part: key, hard: p > 1 });
          break;
        }
      }
    }
  }
  void dt;
  return out;
}

/** 抓住最近的對手(在射程內)。抓住 = 建一條臨時關節,兩邊都會被拖著走。*/
export function grab(W, a) {
  if (W.grabs.has(a.i) || a.hp < 0.5) return null;
  /* 抓取的原點是「胸口往前伸手的那一點」,不是拳頭現在的位置。
     ⚠ 手是垂在身側的(閒置姿勢),拿拳頭位置當原點的話,面前 0.85 m 的對手實際距離
       約 1.0 m ⇒ 永遠抓不到,而畫面上看起來明明就在眼前(首調實測「射程內沒人」)。
     ★ 判準要對上玩家看到的東西:他看到的是「我面前有一隻動物」。*/
  const c = a.parts.chest.translation();
  const hand = { x: c.x + Math.sin(a.facing) * TUNE.grabAhead, y: c.y,
                 z: c.z + Math.cos(a.facing) * TUNE.grabAhead };
  let best = null, bd = TUNE.grabRange;
  for (const b of W.animals) {
    if (b === a) continue;
    for (const key of ['chest', 'pelvis', 'head']) {
      const t = b.parts[key].translation();
      const d = Math.hypot(hand.x - t.x, hand.y - t.y, hand.z - t.z);
      if (d < bd) { bd = d; best = { b, key }; }
    }
  }
  if (!best) return null;
  const j = W.world.createImpulseJoint(
    R.JointData.spherical(V(SIZE.lowerArm[0], 0, 0), V(0, 0, 0)),
    a.parts.armR1, best.b.parts[best.key], true);
  W.grabs.set(a.i, { joint: j, on: best.b.i, key: best.key });
  return W.grabs.get(a.i);
}
/** 放手(或用力甩出去)*/
export function release(W, a, throwIt = false) {
  const g = W.grabs.get(a.i);
  if (!g) return false;
  W.world.removeImpulseJoint(g.joint, true);
  W.grabs.delete(a.i);
  if (throwIt) {
    const b = W.animals[g.on];
    const f = { x: Math.sin(a.facing), z: Math.cos(a.facing) };
    b.parts[g.key].applyImpulse(V(f.x * 9, 3.4, f.z * 9), true);
    b.stun = Math.max(b.stun, 0.6);
    b.hp = 0;
  }
  return true;
}

/* ── 掉台判定 ───────────────────────────────────────────────────────────── */
/** 判準用**pelvis 的高度**,不是水平距離:被推到邊緣還沒掉下去的時候不算輸,
    那一刻的掙扎正是這個遊戲最好看的部分。⚠ 也不能用「碰到地面」——沒有地面,
    台子是浮空的。 */
export const FALL_Y = -3.0;
export function checkFalls(W) {
  const out = [];
  for (const a of W.animals) {
    if (a.fellAt != null) continue;
    if (a.parts.pelvis.translation().y < FALL_Y) { a.fellAt = W.t; out.push(a.i); }
  }
  return out;
}

/** 把一隻動物重置回台上(新一回合)。★ 速度也要歸零,不然上一回合的動量會跟過來。*/
export function respawn(W, a, at) {
  const S = SIZE;
  const yShin = S.shin[0] + S.shin[1];
  const yThigh = yShin + S.shin[0] + S.thigh[0];
  const yPelvis = yThigh + S.thigh[0] + S.pelvis[1];
  const yChest = yPelvis + S.pelvis[1] + S.chest[1];
  const dxLeg = 0.13, dxArm = S.chest[0] + S.upperArm[1];
  const put = (b, x, y, z) => {
    b.setTranslation(V(x, y, z), true);
    b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    b.setLinvel(V(0, 0, 0), true);
    b.setAngvel(V(0, 0, 0), true);
  };
  release(W, a, false);
  put(a.parts.pelvis, at.x, yPelvis + 0.6, at.z);
  put(a.parts.chest, at.x, yChest + 0.6, at.z);
  put(a.parts.head, at.x, yChest + S.chest[1] + S.head + 0.6, at.z);
  for (const [side, sx] of [['L', -1], ['R', 1]]) {
    put(a.parts['arm' + side + '0'], at.x + sx * dxArm, yChest + 0.6, at.z);
    put(a.parts['arm' + side + '1'], at.x + sx * (dxArm + 0.22), yChest + 0.6, at.z);
    put(a.parts['leg' + side + '0'], at.x + sx * dxLeg, yThigh + 0.6, at.z);
    put(a.parts['leg' + side + '1'], at.x + sx * dxLeg, yShin + 0.6, at.z);
  }
  a.hp = 1; a.stun = 0; a.fellAt = null; a.cd.punch = 0; a.cd.jump = 0;
}

/** 推進世界。固定步長 —— 物理用可變 dt 會讓同樣的操作有不同結果(而且測不出來)。*/
/** 🛟 理智夾:任何一顆剛體的速度超過上限就夾回去。
    ★ 這不是遮蓋 bug —— 布娃娃 + 關節 + 每幀施力的系統本來就可能在極端碰撞下發散,
      而發散一次的後果是「角色瞬間消失」,使用者會以為遊戲壞了。
    ★ 但它**同時是一個可以斷言的東西**:測試可以檢查「跑 N 幀之後沒有任何一顆被夾過」,
      被夾過就代表調參有問題,而不是靜靜地繼續跑。⇒ clampCount 會累加,不吞掉。*/
export const MAX_V = 40, MAX_W = 40;
export function sanityClamp(W) {
  let n = 0;
  for (const a of W.animals) for (const key of PARTS) {
    const b = a.parts[key];
    const v = b.linvel(), w = b.angvel();
    const sv = Math.hypot(v.x, v.y, v.z), sw = Math.hypot(w.x, w.y, w.z);
    if (!isFinite(sv) || sv > MAX_V) {
      const k = isFinite(sv) && sv > 0 ? MAX_V / sv : 0;
      b.setLinvel({ x: (v.x || 0) * k, y: (v.y || 0) * k, z: (v.z || 0) * k }, true); n++;
    }
    if (!isFinite(sw) || sw > MAX_W) {
      const k = isFinite(sw) && sw > 0 ? MAX_W / sw : 0;
      b.setAngvel({ x: (w.x || 0) * k, y: (w.y || 0) * k, z: (w.z || 0) * k }, true); n++;
    }
  }
  W.clampCount = (W.clampCount || 0) + n;
  return n;
}

export const STEP = 1 / 60;
export function stepWorld(W, dt, inputs = {}) {
  let acc = dt, n = 0;
  while (acc >= STEP && n < 8) {                 // n 上限:掉幀時不要追到卡死
    for (const a of W.animals) control(W, a, STEP, inputs[a.i]);
    W.world.step();
    sanityClamp(W);
    W.t += STEP;
    acc -= STEP; n++;
  }
  const hits = resolveHits(W, dt);
  const falls = checkFalls(W);
  return { hits, falls, steps: n };
}
