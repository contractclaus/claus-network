import { defineConfig } from 'nitro';

export default defineConfig({
  preset: 'vercel',
  buildDir: '.nitro',
  vercel: { functions: { maxDuration: 800 } },
  modules: ['workflow/nitro'],
  traceDeps: ['@jitl/quickjs-singlefile-cjs-release-sync*'],
  routes: { '/**': './src/index.ts' }
});
