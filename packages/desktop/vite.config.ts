import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const bridgePort = process.env.BRANCHLOOM_WEB_BRIDGE_PORT
const bridgeToken = process.env.BRANCHLOOM_WEB_BRIDGE_TOKEN
const bridgeProxy = bridgePort && bridgeToken
  ? {
      '/__branchloom': {
        target: `http://127.0.0.1:${bridgePort}`,
        changeOrigin: false,
        headers: { 'X-Branchloom-Token': bridgeToken },
        rewrite: (path: string) => path.replace(/^\/__branchloom/, ''),
      },
    }
  : undefined

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/target/**'],
    },
    proxy: bridgeProxy,
  },
  preview: { proxy: bridgeProxy },
})
