/* 合成音效(零音檔、離線可用)。
   ⚠ 3d-game-kit 鐵則 2:任何「唸出來的句子」一律預烤神經人聲 mp3(雲哲/曉臻),
     不可以用瀏覽器內建的機器語音。
     本作 v1 **刻意沒有語音播報** —— 這裡只有音效(拍擊/掉落/得分),所以沒有違反那一條。
     ★ 但這裡有一個很容易犯的順手:本檔已經有 AudioContext 了,想加「一號得分!」時
       最短的路就是接瀏覽器內建語音 —— 那正是被禁的那條路。
       要加播報請走 [[baked-voice-commentary]]:詞庫 → gen-voice.mjs 烤 mp3 → runtime 有檔才播、
       缺檔只出字幕。已寫進 roadmap,不要在這裡走捷徑。*/
export class Audio {
  constructor() { this.ctx = null; this.on = true; }
  _c() {
    if (!this.on) return null;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
  /** 一顆音:波形 + 頻率掃描 + 音量包絡 */
  _tone(f0, f1, dur, type = 'sine', vol = 0.22) {
    const c = this._c(); if (!c) return;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, c.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), c.currentTime + dur);
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.exponentialRampToValueAtTime(vol, c.currentTime + Math.min(0.02, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    o.connect(g).connect(c.destination);
    o.start(); o.stop(c.currentTime + dur + 0.02);
  }
  /** 噪音爆(拍擊感) */
  _noise(dur, vol = 0.3, hp = 300) {
    const c = this._c(); if (!c) return;
    const n = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, n, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp;
    const g = c.createGain(); g.gain.value = vol;
    src.connect(f).connect(g).connect(c.destination); src.start();
  }
  swing() { this._tone(520, 260, 0.11, 'triangle', 0.11); }
  hit(hard) {
    this._noise(hard ? 0.16 : 0.10, hard ? 0.34 : 0.22, hard ? 220 : 420);
    this._tone(hard ? 150 : 240, 70, 0.14, 'square', 0.12);
  }
  grab() { this._tone(300, 520, 0.09, 'sine', 0.14); }
  throwIt() { this._tone(220, 720, 0.18, 'sawtooth', 0.13); }
  jump() { this._tone(340, 620, 0.12, 'sine', 0.13); }
  /** 掉下去:往下掃 + 落地那一聲「啵」 */
  fall() {
    this._tone(700, 90, 0.55, 'sine', 0.2);
    setTimeout(() => this._tone(160, 60, 0.18, 'triangle', 0.16), 520);
  }
  point() { [523, 659, 784].forEach((f, i) => setTimeout(() => this._tone(f, f, 0.14, 'sine', 0.18), i * 90)); }
  win() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this._tone(f, f, 0.22, 'triangle', 0.2), i * 135)); }
}
