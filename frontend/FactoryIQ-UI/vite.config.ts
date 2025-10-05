// vite.config.ts
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

function fixRcUtilReactVersion(): Plugin {
  return {
    name: 'fix-rc-util-react-version',
    enforce: 'pre', // ← литерал, не string
    transform(code, id) {
      const isRef =
        ((id.includes('/rc-util/') || id.includes('\\rc-util\\')) &&
          (id.endsWith('/ref.js') || id.endsWith('\\ref.js')));

      if (isRef && code.includes('version.split')) {
        const patched = code
          // ESM вариант: import { version } from 'react'
          .replace(/Number\(\s*version\.split\([^)]*\)\[0\]\s*\)/g, '19')
          // CJS вариант: var ReactMajorVersion = Number(_react.version.split(...)[0])
          .replace(/Number\(\s*_react\.version\.split\([^)]*\)\[0\]\s*\)/g, '19');

        return { code: patched, map: null };
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [react(), fixRcUtilReactVersion()],
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
});
