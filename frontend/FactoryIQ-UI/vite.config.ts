import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      react: resolve(__dirname, 'src/compat/react-shim.js'),
      'react/jsx-runtime': 'react/jsx-runtime'
    }
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react')) return 'react'
            if (id.includes('antd')) return 'antd'
            if (id.includes('xlsx')) return 'xlsx'
            if (id.includes('file-saver')) return 'filesaver'
            if (id.includes('dayjs')) return 'dayjs'
            if (id.includes('react-router-dom')) return 'router'
            if (id.includes('react-toastify')) return 'toastify'
            return 'vendor'
          }
        }
      }
    }
  }
})
