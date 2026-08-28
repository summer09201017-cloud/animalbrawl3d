import { defineConfig } from 'vite';
export default defineConfig({
  base: './',                       // 相對路徑:CF Pages / 子路徑 / 本機雙擊都能開
  build: { target: 'es2022', chunkSizeWarningLimit: 2200 },
  /* Rapier 的 compat 版把 wasm 內嵌成 base64,所以**不需要**任何 wasm 外掛或
     特殊 assetsInclude —— 這是選 -compat 而不是 @dimforge/rapier3d 的主要理由:
     少一層建置設定、少一個「本機好但線上壞」的風險面。 */
  server: { open: false },
});
