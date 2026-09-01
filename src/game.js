/* ═══════════════════════════════════════════════════════════════════════════
   毛毛大亂鬥 — 視覺層 + 規則 + AI
   ═══════════════════════════════════════════════════════════════════════════
   分工(刻意的):
     src/physics.js  純 Rapier,**不 import three** ⇒ node 測試驅動真的物理
     src/game.js     three 場景 + 每幀從物理同步 + 回合規則 + AI(本檔)
     src/main.js     UI/HUD/輸入(不碰物理)
   ⇒ 物理與規則的斷言不需要 renderer,所以不會掉進 3d-game-kit 那條
     「headless 測試永遠綠(沒有 renderer 就 early-return)」的坑。
   ═══════════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import {
  initPhysics, createWorld, addAnimal, stepWorld, jump, punch, grab, release,
  respawn, PARTS, SIZE, TUNE,
} from './physics.js';

/* ── 動物設定(純視覺 + 一句自我介紹)───────────────────────────────────── */
export const KINDS = {
  cat: { name: '小貓', fur: 0xf6a94a, belly: 0xffe0b2, ear: 'triangle', tail: 'long', nose: 0xd2694a },
  dog: { name: '小狗', fur: 0x9c6b4a, belly: 0xf0dcc8, ear: 'floppy', tail: 'stub', nose: 0x3a2a22 },
  bunny: { name: '小兔', fur: 0xf2f0ee, belly: 0xffffff, ear: 'tall', tail: 'puff', nose: 0xe58fa0 },
  duck: { name: '小鴨', fur: 0xf7d64a, belly: 0xfff0a8, ear: 'none', tail: 'stub', nose: 0xef8a3c },
};
export const KIND_LIST = Object.keys(KINDS);

/* 每位玩家的隊色(HUD 與腳下光圈共用一份 —— 兩份顏色遲早漂移)*/
export const TEAM = [
  { key: 'p1', label: '一號', color: 0x4fc3f7, css: '#4fc3f7' },
  { key: 'p2', label: '二號', color: 0xff8a65, css: '#ff8a65' },
];

const M = (c, opts = {}) => new THREE.MeshStandardMaterial({
  color: c, roughness: opts.rough ?? 0.72, metalness: 0,
  /* 3d-game-kit §1:膚色/毛色要加 emissive,否則臉在光背面完全看不清。*/
  emissive: opts.emissive ?? new THREE.Color(c).multiplyScalar(0.18),
  ...opts.extra,
});

/**
 * 造一隻動物的視覺體。每個部位一個 Group,對應 physics 的一顆剛體。
 * ★ 臉部鐵則(3d-game-kit §1,違反必被退件):白眼珠 + 黑瞳孔 + 眉毛 + 微笑弧,四樣都要有。
 *   ⚠ 而且眼睛要貼**頭的本地 +z**:頭是自由旋轉的剛體,貼錯面的話玩家大部分時間
 *     看到的是後腦勺,而那不會有任何測試會紅(它只是「看起來沒做完」)。
 */
function buildAnimalMesh(kind, teamColor) {
  const K = KINDS[kind] || KINDS.cat;
  const fur = M(K.fur), belly = M(K.belly), dark = M(0x2b2b2b, { rough: 0.5 });
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, emissive: 0x555555 });
  const g = {};

  /* 軀幹:**橢球**,不是方塊。
     ⚠ 0828 使用者回報「角色不夠圓潤」—— 首版胸與髖用 BoxGeometry,
       在一堆膠囊四肢與圓頭之間,那兩塊方的特別顯眼,整隻看起來像積木人。
     ★ 物理形狀**照舊是 cuboid**(碰撞方塊比橢球快又穩),只有看的那一層改圓 ——
       視覺與碰撞形狀不必一致,差幾公分玩家感覺不出來,但方角一眼就看得到。
     ★ 稍微脹一點(1.06)蓋住方形碰撞箱的角,才不會出現「圓身體卡在方角上」的錯覺。*/
  const mkBlob = (h, mat, plump = 1.06) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 18), mat);
    m.scale.set(h[0] * plump, h[1] * plump, h[2] * plump);
    return m;
  };
  g.pelvis = new THREE.Group(); g.pelvis.add(mkBlob(SIZE.pelvis, fur));
  g.chest = new THREE.Group();
  g.chest.add(mkBlob(SIZE.chest, fur, 1.08));
  {  // 肚子那一片淺色(可愛感的來源之一)—— 也改成貼在球面上的扁橢球
    const b = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), belly);
    b.scale.set(SIZE.chest[0] * 0.66, SIZE.chest[1] * 0.74, SIZE.chest[2] * 0.62);
    b.position.z = SIZE.chest[2] * 0.62; g.chest.add(b);
  }

  // 頭 + 臉
  g.head = new THREE.Group();
  const R = SIZE.head;
  g.head.add(new THREE.Mesh(new THREE.SphereGeometry(R, 22, 16), fur));
  const eye = (sx) => {
    const e = new THREE.Group();
    /* 🏷 臉部零件一律**取名字**。理由是驗收:
       測試要釘的是「臉上有沒有眼白/瞳孔/眉毛/嘴」,不是「它們是什麼幾何形狀」。
       ⚠ 首版按 geometry.type 數(眉毛=BoxGeometry × 2),0828 把眉毛改成膠囊
         之後測試當場紅 —— 而紅的是測試不是程式(同 /mutation-check 第四個姊妹坑:
         斷言釘了「這一版剛好的實作細節」)。取名字之後,換幾何形狀不會紅,
         真的把眉毛刪掉才會紅。*/
    const w = new THREE.Mesh(new THREE.SphereGeometry(R * 0.30, 14, 10), white);
    w.name = 'eyeWhite';
    const p = new THREE.Mesh(new THREE.SphereGeometry(R * 0.155, 12, 9), dark);
    p.name = 'pupil';
    p.position.z = R * 0.22;
    const brow = new THREE.Mesh(new THREE.CapsuleGeometry(R * 0.05, R * 0.34, 6, 10), dark);
    brow.rotation.z = Math.PI / 2;                       // 膠囊長軸轉成水平
    brow.name = 'brow';
    brow.position.set(0, R * 0.40, R * 0.16);
    brow.rotation.x = sx * 0.26;                        // 兩邊眉毛外八 = 好脾氣
    e.add(w, p, brow);
    e.position.set(sx * R * 0.42, R * 0.16, R * 0.76);
    return e;
  };
  g.head.add(eye(-1), eye(1));
  {  // 鼻子 + 微笑弧(TorusGeometry 半圈)
    const nose = new THREE.Mesh(new THREE.SphereGeometry(R * 0.17, 12, 9), M(K.nose, { rough: 0.4 }));
    nose.name = 'nose';
    nose.position.set(0, -R * 0.06, R * 0.96); nose.scale.set(1.25, 0.85, 0.8);
    const smile = new THREE.Mesh(new THREE.TorusGeometry(R * 0.30, R * 0.045, 8, 18, Math.PI), dark);
    smile.name = 'smile';
    smile.position.set(0, -R * 0.36, R * 0.82);
    smile.rotation.z = Math.PI;                          // 開口朝下 = 微笑(朝上會變成哭臉)
    g.head.add(nose, smile);
  }
  // 耳朵(四種造型)
  const earMat = M(K.fur, { rough: 0.8 });
  if (K.ear === 'triangle') for (const sx of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.ConeGeometry(R * 0.34, R * 0.6, 4), earMat);
    e.position.set(sx * R * 0.55, R * 0.85, 0); e.rotation.z = sx * 0.26; g.head.add(e);
  }
  if (K.ear === 'tall') for (const sx of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.CapsuleGeometry(R * 0.17, R * 1.05, 6, 10), earMat);
    e.position.set(sx * R * 0.42, R * 1.15, 0); e.rotation.z = sx * 0.20; g.head.add(e);
  }
  if (K.ear === 'floppy') for (const sx of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.CapsuleGeometry(R * 0.20, R * 0.7, 6, 10), earMat);
    e.position.set(sx * R * 0.80, R * 0.30, 0); e.rotation.z = sx * 1.15; g.head.add(e);
  }
  if (K.ear === 'none') {  // 小鴨:改成扁嘴
    const bill = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12), M(K.nose, { rough: 0.5 }));
    bill.scale.set(R * 0.38, R * 0.10, R * 0.32);
    bill.position.set(0, -R * 0.18, R * 0.94); g.head.add(bill);
  }

  // 四肢
  const limb = (hh, r, mat) => {
    const grp = new THREE.Group();
    grp.add(new THREE.Mesh(new THREE.CapsuleGeometry(r, hh * 2, 10, 16), mat));
    return grp;
  };
  const paw = M(K.belly, { rough: 0.6 });
  for (const side of ['L', 'R']) {
    g['arm' + side + '0'] = limb(SIZE.upperArm[0], SIZE.upperArm[1], fur);
    const lo = limb(SIZE.lowerArm[0], SIZE.lowerArm[1], fur);
    {  // 手掌:一顆淺色球,才看得出「手」在哪(打人的時候玩家要看得到拳頭)
      const h = new THREE.Mesh(new THREE.SphereGeometry(SIZE.lowerArm[1] * 1.25, 12, 9), paw);
      h.position.y = -SIZE.lowerArm[0] - SIZE.lowerArm[1] * 0.4; lo.add(h);
    }
    g['arm' + side + '1'] = lo;
    g['leg' + side + '0'] = limb(SIZE.thigh[0], SIZE.thigh[1], fur);
    const sh = limb(SIZE.shin[0], SIZE.shin[1], fur);
    {
      const f = new THREE.Mesh(new THREE.SphereGeometry(SIZE.shin[1] * 1.3, 12, 9), paw);
      f.position.y = -SIZE.shin[0] - SIZE.shin[1] * 0.3; f.scale.set(1.1, 0.8, 1.35); sh.add(f);
    }
    g['leg' + side + '1'] = sh;
  }
  // 尾巴掛在 pelvis
  if (K.tail === 'long') {
    const t = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.4, 5, 8), fur);
    t.position.set(0, 0.05, -SIZE.pelvis[2] - 0.16); t.rotation.x = -1.05; g.pelvis.add(t);
  } else if (K.tail === 'puff') {
    const t = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 9), M(K.belly));
    t.position.set(0, 0.04, -SIZE.pelvis[2] - 0.09); g.pelvis.add(t);
  } else {
    const t = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.14, 5, 8), fur);
    t.position.set(0, 0.10, -SIZE.pelvis[2] - 0.08); t.rotation.x = -0.6; g.pelvis.add(t);
  }
  // 隊色領巾(分辨誰是誰 —— 同一種動物對打時這是唯一的線索)
  {
    const s = new THREE.Mesh(new THREE.TorusGeometry(SIZE.chest[0] * 0.92, 0.045, 8, 20),
      M(teamColor, { rough: 0.45 }));
    s.position.y = SIZE.chest[1] * 0.95; s.rotation.x = Math.PI / 2; g.chest.add(s);
  }
  for (const k of PARTS) { g[k].castShadow = true; g[k].traverse(o => { o.castShadow = true; }); }
  return g;
}

/* ── 主體 ──────────────────────────────────────────────────────────────── */
/* 視角。★ 0828 使用者回報「視角不要一直旋轉」——
   首版預設是 chase(鏡頭掛在一號的 facing 上)⇒ 玩家一轉身鏡頭就跟著轉,
   整個畫面一直在旋,看久了頭暈、也分不清哪邊是台邊。
   ⇒ **預設改成 fixed:鏡頭跟著人「平移」,但方向永遠不變。**
     會轉的 chase 留在最後一檔給想要的人選,不再是預設。
   ⚠ 固定機位的必要配套(3d-game-kit 0826 sheepflock3d 實錘):
     移動輸入必須**相對鏡頭**,不然會出現「按右卻往左走」——
     main.js 的 moveFromKeys 本來就是用鏡頭的前/右向量算的,所以這條已經成立。*/
export const VIEWS = [
  { key: 'fixed', name: '固定機位(不轉)' },
  { key: 'side', name: '側面轉播' },
  { key: 'top', name: '高空俯瞰' },
  { key: 'chase', name: '跟隨(會轉)' },
];

export class Game {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.onEvent = opts.onEvent || (() => { });
    this.winScore = opts.winScore ?? 3;
    this.viewIdx = 0;
    this.state = 'menu';          // menu | fight | roundEnd | matchEnd
    this.round = 1;
    this.msg = '';
    this._camPos = new THREE.Vector3(0, 6, 10);
    this._camLook = new THREE.Vector3(0, 1, 0);
    this._camUp = new THREE.Vector3(0, 1, 0);
    this.roundEndT = 0;
    /* 🎲 隨機源可注入。AI 用隨機決定何時出手,而 Math.random 讓測試變成 flaky
       —— 實測 12 次紅 1 次(AI 偶爾自己走下台)。
       ★ flaky 測試比沒測試更糟:紅一次沒人查、綠一次就以為修好了,
         而它遲早會在「真的壞了」那一次被當成雜訊放過去。
       ⇒ 測試傳固定種子的 LCG,遊戲照用 Math.random。*/
    this.rng = opts.rng || Math.random;
  }

  async init(cfg = {}) {
    await initPhysics();
    this.cfg = {
      kinds: cfg.kinds || ['cat', 'dog'],
      ai: cfg.ai ?? [false, true],
      arenaRadius: cfg.arenaRadius ?? 5.0,
      winScore: cfg.winScore ?? this.winScore,
    };
    this.winScore = this.cfg.winScore;
    this._buildScene();
    this._buildWorld();
    this.state = 'fight';
    this.msg = '第 1 回合 —— 把對手推下台!';
    return this;
  }

  _buildScene() {
    /* 🧪 headless:node 沒有 WebGL,所以測試傳 headless:true 換一顆**假 renderer**。
       ★ 這不是為了讓測試好過,是為了讓**視覺層的程式路徑真的被跑到** ——
         3d-game-kit 的血案(#46 visible 只認嚴格 false)就是因為
         「沒有 renderer 就整段 early-return ⇒ 測試永遠綠」。
         這裡只換掉 renderer,場景建構、人物建構、每幀同步、鏡頭、visible 指派
         全部照跑,所以那一族的錯抓得到。*/
    if (this.opts.headless) {
      this.renderer = { setSize() {}, setPixelRatio() {}, render() { this._n = (this._n || 0) + 1; },
                        shadowMap: {}, _fake: true };
    } else {
      const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
      r.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer = r;
    }
    const s = new THREE.Scene();
    s.background = new THREE.Color(0x8fd3f4);
    s.fog = new THREE.Fog(0x8fd3f4, 18, 46);
    this.scene = s;
    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 200);
    s.add(new THREE.HemisphereLight(0xffffff, 0x7a8f5a, 0.85));
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.15);
    sun.position.set(7, 13, 6); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const d = 9; Object.assign(sun.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 1, far: 40 });
    s.add(sun);
    /* 幾朵雲當背景(浮空台子要有天空感,不然像在真空裡打架)
       ⚠⚠ 0901 修:原本「有畫,但畫面上一朵都看不到」,三個原因疊起來 ——
         ① 材質吃霧,而 `fog` 的顏色**跟天空同色**(0x8fd3f4)、遠端只有 46
            ⇒ 擺在 ±30 的雲幾乎完全被霧化成天空,等於隱形。⇒ 這一層明確 `fog: false`。
         ② 高度擺到 y=7~19,而鏡頭是俯角往下看 ⇒ 大半在畫面外。⇒ 壓到 4.5~11。
         ③ 隨機散在 ±30 的方塊裡,離台子太遠、又可能全落在鏡頭背後。
            ⇒ 改成**環狀**分佈(半徑 15~27),繞著台子一圈,任何視角都會有幾朵在框裡。
       ★ 而且要留參照:this.clouds 讓驗收腳本能數「畫面裡看得到幾朵」——
         「有沒有畫」跟「看不看得見」是兩件事,只有後者算數。*/
    this.clouds = [];
    for (let i = 0; i < 16; i++) {
      const c = new THREE.Mesh(new THREE.SphereGeometry(1.3 + Math.random() * 1.5, 9, 7),
        new THREE.MeshBasicMaterial({ color: 0xfdfdff, transparent: true, opacity: 0.92, fog: false }));
      const ang = (i / 16) * Math.PI * 2 + Math.random() * 0.35;
      const rad = 15 + Math.random() * 12;
      /* ★ 大部分的雲擺在**台子下方**(y −9~−3),少數留在上方(y 2~7)。
         理由是幾何而不是美感:鏡頭是俯角往下看的,兩隻靠近時俯角約 44°、
         畫面上緣只到「水平線下 18°」⇒ **天空完全不在畫面裡**,擺在頭頂的雲一朵都看不到
         (0901 兩次改完都還是 0 朵,診斷過才看清楚:aboveTop 6 朵、behind 6 朵)。
         擺在下方的雲落在俯角 25~60°,四個視角都在框內 ——
         而且「浮空台子看得到腳下的雲」本身就對,高度感正是這樣來的。
         上方那幾朵留給側面轉播(那個機位俯角淺,看得到天空)。*/
      const low = i < 11;
      c.position.set(Math.sin(ang) * rad, low ? -9 + Math.random() * 6 : 2 + Math.random() * 5, Math.cos(ang) * rad);
      c.scale.set(1.5, 0.5, 1);
      s.add(c); this.clouds.push(c);
      /* 每朵配一顆小的疊在旁邊,才像雲不像球 */
      const c2 = new THREE.Mesh(new THREE.SphereGeometry(0.9 + Math.random(), 8, 6), c.material);
      c2.position.copy(c.position);
      c2.position.x += (Math.random() - 0.5) * 3.2; c2.position.y -= 0.35;
      c2.scale.set(1.3, 0.5, 1);
      s.add(c2); this.clouds.push(c2);
    }
  }

  _buildWorld() {
    const R = this.cfg.arenaRadius;
    this.W = createWorld({ arenaRadius: R });
    // 台子
    const top = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 0.96, 0.5, 48),
      M(0x7ac36a, { rough: 0.9 }));
    top.position.y = -0.25; top.receiveShadow = true; this.scene.add(top);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.09, 8, 60), M(0xf2e6a8, { rough: 0.6 }));
    rim.rotation.x = Math.PI / 2; this.scene.add(rim);
    // 台子下方一根柱子(讓「浮空」看起來有理由)
    const col = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.35, R * 0.22, 14, 20), M(0x8d6e63));
    col.position.y = -7.5; this.scene.add(col);

    this.mesh = [];
    this.rings = [];
    const n = this.cfg.kinds.length;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const at = { x: Math.sin(ang) * R * 0.45, z: Math.cos(ang) * R * 0.45 };
      const a = addAnimal(this.W, at, this.cfg.kinds[i]);
      a.facing = Math.atan2(-at.x, -at.z);                 // 一開始面向場中央
      const g = buildAnimalMesh(this.cfg.kinds[i], TEAM[i % TEAM.length].color);
      for (const k of PARTS) this.scene.add(g[k]);
      this.mesh.push(g);
      // 腳下隊色光圈:兩隻同種動物時唯一分得出誰是誰的東西
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.30, 0.42, 26),
        new THREE.MeshBasicMaterial({ color: TEAM[i % TEAM.length].color, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; this.scene.add(ring); this.rings.push(ring);
    }
    this.spawns = this.W.animals.map((_, i) => {
      const ang = (i / n) * Math.PI * 2;
      return { x: Math.sin(ang) * R * 0.45, z: Math.cos(ang) * R * 0.45 };
    });
  }

  /* ── 輸入(main.js 每幀餵進來)───────────────────────────────────────── */
  /** @param {Array<{dx:number,dz:number}>} moves 每位玩家的移動方向(世界座標) */
  setMoves(moves) { this._moves = moves; }
  doJump(i) { const a = this.W?.animals[i]; return a ? jump(this.W, a) : false; }
  doPunch(i) {
    const a = this.W?.animals[i]; if (!a) return false;
    const r = punch(this.W, a, a._nextHand === 'L' ? 'L' : 'R');
    if (r) { a._nextHand = a._nextHand === 'L' ? 'R' : 'L'; this.onEvent({ type: 'swing', who: i }); }
    return !!r;
  }
  doGrab(i) {
    const a = this.W?.animals[i]; if (!a) return false;
    if (this.W.grabs.has(i)) { const ok = release(this.W, a, true); if (ok) this.onEvent({ type: 'throw', who: i }); return ok; }
    const g = grab(this.W, a);
    if (g) this.onEvent({ type: 'grab', who: i, on: g.on });
    return !!g;
  }
  cycleView() { this.viewIdx = (this.viewIdx + 1) % VIEWS.length; return VIEWS[this.viewIdx]; }

  /* ── AI ────────────────────────────────────────────────────────────────
     刻意做得笨一點:AI 的樂趣不在強,而在「它也會被自己絆倒」。
     ⚠ 不可以「站在射程內就必打」——那會變成沒有節奏的連打(同 3d-game-kit
       那條「攔截不可站在路徑上就必攔」的同族)。所以出手有機率與冷卻。 */
  _ai(i, dt) {
    const me = this.W.animals[i];
    const foe = this.W.animals.find(x => x !== me && x.fellAt == null);
    if (!foe || me.fellAt != null) return { dx: 0, dz: 0 };
    me._aiT = (me._aiT || 0) - dt;
    const mp = me.parts.chest.translation(), fp = foe.parts.chest.translation();
    let dx = fp.x - mp.x, dz = fp.z - mp.z;
    const d = Math.hypot(dx, dz) || 1;
    /* 邊緣自保:離台邊太近就先往中間走(不然 AI 會自己走下去,而那不好笑只讓人覺得爛)*/
    const rMe = Math.hypot(mp.x, mp.z);
    /* 邊緣自保:0.78 太晚(實測 12 場會有 1 場自己掉下去)⇒ 提早到 0.68,
       而且**離邊愈近就愈全力往內走**(不是固定速度往內飄)。*/
    if (rMe > this.cfg.arenaRadius * 0.68) {
      const k = Math.min(1, (rMe / this.cfg.arenaRadius - 0.68) / 0.22 + 0.5);
      return { dx: -mp.x / (rMe || 1) * k, dz: -mp.z / (rMe || 1) * k };
    }
    if (me._aiT <= 0) {
      me._aiT = 0.35 + this.rng() * 0.5;
      /* ⚠ 靠近台邊時**不出拳** —— 出拳會給自己一個往前的反作用力,
         那正是 AI 自己走下台的最後一步(邊緣自保只管走路,管不到出手)。*/
      const safe = rMe < this.cfg.arenaRadius * 0.62;
      if (d < 1.15 && safe && this.rng() < 0.55) this.doPunch(i);
      else if (d < 0.9 && safe && this.rng() < 0.25) this.doGrab(i);
      else if (d > 3 && safe && this.rng() < 0.12) this.doJump(i);
    }
    if (d < 0.75) return { dx: 0, dz: 0 };            // 太近就別再擠
    return { dx: dx / d, dz: dz / d };
  }

  /* ── 每幀 ──────────────────────────────────────────────────────────── */
  update(dt) {
    if (!this.W) return;
    dt = Math.min(dt, 1 / 20);                         // 掉幀時不要讓物理一次跳太多
    const inputs = {};
    for (let i = 0; i < this.W.animals.length; i++) {
      if (this.state !== 'fight') { inputs[i] = { dx: 0, dz: 0 }; continue; }
      inputs[i] = this.cfg.ai[i] ? this._ai(i, dt) : (this._moves?.[i] || { dx: 0, dz: 0 });
    }
    const r = stepWorld(this.W, dt, inputs);
    for (const h of r.hits) this.onEvent({ type: 'hit', ...h });
    if (r.falls.length && this.state === 'fight') this._onFall(r.falls);
    this._syncMeshes();
    this._updateCamera(dt);
    if (this.state === 'roundEnd' && this.W.t >= this.roundEndT) this._nextRound();
  }

  _onFall(fallen) {
    /* 掉下去的人不得分,其餘的人各得一分(兩人局就是對手得分)*/
    for (const a of this.W.animals) if (!fallen.includes(a.i) && a.fellAt == null) a.score++;
    const loser = fallen[0];
    const winner = this.W.animals.find(a => !fallen.includes(a.i));
    this.onEvent({ type: 'fall', who: loser, scorer: winner ? winner.i : null });
    const champ = this.W.animals.find(a => a.score >= this.winScore);
    if (champ) {
      this.state = 'matchEnd';
      this.msg = `🏆 ${TEAM[champ.i % TEAM.length].label}(${KINDS[this.cfg.kinds[champ.i]].name})贏了這一場!`;
      this.onEvent({ type: 'matchEnd', who: champ.i });
    } else {
      this.state = 'roundEnd';
      this.roundEndT = this.W.t + 1.6;
      this.msg = winner
        ? `${TEAM[winner.i % TEAM.length].label} 得分!`
        : '同時掉下去了!';
      this.onEvent({ type: 'roundEnd' });
    }
  }
  _nextRound() {
    this.round++;
    for (let i = 0; i < this.W.animals.length; i++) respawn(this.W, this.W.animals[i], this.spawns[i]);
    this.state = 'fight';
    this.msg = `第 ${this.round} 回合`;
  }
  /** 重新開一場(比分歸零)*/
  restart() {
    for (let i = 0; i < this.W.animals.length; i++) {
      respawn(this.W, this.W.animals[i], this.spawns[i]);
      this.W.animals[i].score = 0;
    }
    this.round = 1; this.state = 'fight'; this.msg = '第 1 回合 —— 把對手推下台!';
  }

  _syncMeshes() {
    for (let i = 0; i < this.W.animals.length; i++) {
      const a = this.W.animals[i], g = this.mesh[i];
      for (const k of PARTS) {
        const t = a.parts[k].translation(), q = a.parts[k].rotation();
        g[k].position.set(t.x, t.y, t.z);
        g[k].quaternion.set(q.x, q.y, q.z, q.w);
      }
      // 腳下光圈貼在台面上;掉下台之後就不要留在原地(!! 見下面那條鐵則)
      const p = a.parts.pelvis.translation();
      const ring = this.rings[i];
      ring.position.set(p.x, 0.03, p.z);
      /* ★ 3d-game-kit:`mesh.visible` 只認嚴格 false ——
         任何運算式一律包 `!!`,漏掉的代價是「莫名多一個東西浮在畫面上」。*/
      ring.visible = !!(a.fellAt == null && p.y > -0.5);
    }
  }

  _updateCamera(dt) {
    const A = this.W.animals;
    const c = new THREE.Vector3();
    let n = 0;
    for (const a of A) { const t = a.parts.chest.translation(); if (a.fellAt == null) { c.add(new THREE.Vector3(t.x, t.y, t.z)); n++; } }
    if (n) c.divideScalar(n); else c.set(0, 1, 0);
    const R = this.cfg.arenaRadius;
    let pos, look = c.clone(), up = new THREE.Vector3(0, 1, 0);
    const view = VIEWS[this.viewIdx].key;
    if (view === 'fixed') {
      /* 固定機位:方向是常數,只跟著人平移 ⇒ 畫面永遠不旋轉。
         ★ 高度與距離跟著「兩隻分得多開」微調,兩個人跑到對角時才框得住,
           但**方向不變** —— 會變的只有位置,那不會讓人頭暈。
         ⚠⚠ 0901 修構圖:原本 back=7.0/up=4.2 ⇒ 角色只佔畫面高 ~13%,
            而畫面上緣有一大片空天空。教室投影時坐後排的孩子分不出誰是誰。
            ⇒ ① 基礎距離拉近(7.0→5.0),角色變大;
               ② 俯角加大(up 4.2→4.8),地平線往上推 ⇒ 空天空變少;
               ③ 看的點從「胸口」下移到胸口與台面之間(*0.45),
                  角色因此坐在畫面中央略上,下方是台子而不是天空。
            ④ 分開時仍然拉遠(係數 1.15→1.35),不然兩隻跑開就框不住。*/
      let spread = 0;
      for (const a of A) {
        if (a.fellAt != null) continue;
        const t = a.parts.chest.translation();
        spread = Math.max(spread, Math.hypot(t.x - c.x, t.z - c.z));
      }
      const back = 5.0 + spread * 1.35, up = 4.8 + spread * 0.62;
      pos = new THREE.Vector3(c.x, c.y + up, c.z + back);
      look = new THREE.Vector3(c.x, c.y * 0.45, c.z);
    } else if (view === 'chase') {
      /* 跟隨:鏡頭在一號背後。
         ⚠⚠ 0901 修:原本 6.2 遠 / 3.4 高 ⇒ 太低太近,台面佔掉畫面下 3/4,
            而**對手常常不在畫面裡** —— 四個視角裡對孩子最沒用的一個。
            ⇒ 拉高拉遠,而且跟著「兩隻分得多開」一起退,對手才留在框內;
              看的點也略微抬高(不是看腳底),地平線才不會壓在畫面正中。*/
      const me = A[0];
      const f = me ? me.facing : 0;
      let spread = 0;
      for (const a of A) {
        if (a.fellAt != null) continue;
        const t = a.parts.chest.translation();
        spread = Math.max(spread, Math.hypot(t.x - c.x, t.z - c.z));
      }
      /* 距離/高度:0901 兩次調整後定案。7.8+spread*1.15 兩隻分開時角色只剩畫面高 10%,
         6.4+spread*0.78 量到 13~15% 而對手仍在框內(驗收兩條同時綠才算對)。*/
      const dist = 6.4 + spread * 0.78, up = 4.4 + spread * 0.38;
      pos = new THREE.Vector3(c.x - Math.sin(f) * dist, c.y + up, c.z - Math.cos(f) * dist);
      look = new THREE.Vector3(c.x, c.y * 0.7, c.z);
    } else if (view === 'side') {
      /* 側面轉播:固定在場邊的機位。
         ⚠ 0901 修:原本 R+5.5 遠 ⇒ 角色只佔畫面高 13.6%,投影後排看不清。
           拉近到 R+3.4,並跟著「兩隻分得多開」退,分開時才不會有人出框。*/
      let spread = 0;
      for (const a of A) {
        if (a.fellAt != null) continue;
        const t = a.parts.chest.translation();
        spread = Math.max(spread, Math.hypot(t.x - c.x, t.z - c.z));
      }
      pos = new THREE.Vector3(R + 2.4 + spread * 0.7, 3.5 + spread * 0.3, 0);
      look = new THREE.Vector3(c.x, c.y * 0.6, c.z);
    } else {   // top
      /* ⚠ 正上方視角:視線與 up=(0,1,0) 平行 = 退化,lookAt 的 roll 變隨機
         (3d-game-kit 實錄:畫面斜斜的,而且每次進來斜的角度還不一樣)。
         ⇒ 這個視角把 up 明確定成場地軸,並且 up 也走同一支 lerp,切視角才不甩頭。
         ⚠⚠ 0901 修:原本鏡頭**跟著玩家平移**(c.x/c.z)+ 固定高度 14。
            這個視角的職責是「一眼看到整個台子」,而跟著玩家跑正好會把遠端台緣推出畫面
            (玩家偏離中心 1.5 m,遠邊就到 8.0 m > 半視高 6.83 ⇒ 出框)。
            ⇒ 改成**固定在場地中心正上方**,高度由台子半徑與實際視角算出來(留 14% 邊)。
              順帶好處:畫面完全不飄,俯瞰本來就該是穩的。*/
      const half = THREE.MathUtils.degToRad(this.camera.fov) / 2;
      const need = R / Math.tan(half) * 1.14;
      pos = new THREE.Vector3(0, Math.max(9, need), 0.001);
      look = new THREE.Vector3(0, 0, 0);
      up = new THREE.Vector3(0, 0, -1);
    }
    const k = 1 - Math.exp(-dt * 3.2);
    this._camPos.lerp(pos, k);
    this._camLook.lerp(look, k);
    this._camUp.lerp(up, k).normalize();
    this.camera.position.copy(this._camPos);
    this.camera.up.copy(this._camUp);
    this.camera.lookAt(this._camLook);
  }

  resize(w, h) {
    if (!this.renderer) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }
  render() { if (this.renderer) this.renderer.render(this.scene, this.camera); }

  /** HUD 要的東西一次給齊(main.js 不要自己去翻物理內部)*/
  hud() {
    return {
      state: this.state, round: this.round, msg: this.msg, view: VIEWS[this.viewIdx].name,
      winScore: this.winScore,
      players: this.W.animals.map((a, i) => ({
        i, label: TEAM[i % TEAM.length].label, css: TEAM[i % TEAM.length].css,
        kind: KINDS[this.cfg.kinds[i]].name, score: a.score,
        dizzy: a.stun > 0, held: this.W.grabs.has(i), ai: !!this.cfg.ai[i],
        onEdge: (() => { const p = a.parts.pelvis.translation(); return Math.hypot(p.x, p.z) > this.cfg.arenaRadius * 0.8; })(),
      })),
    };
  }
}

export { TUNE };
