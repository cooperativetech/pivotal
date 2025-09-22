import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { readFileSync } from 'fs'

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    tailwindcss(),
  ],
  root: 'src',
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  server: {
    ...(command === 'serve' && {
      https: {
        cert: readFileSync(path.resolve(__dirname, '.cert/cert.pem')),
        key: readFileSync(path.resolve(__dirname, '.cert/key.pem')),
      },
    }),
    proxy: {
      '/local_api': 'http://localhost:3001',
      '/api': 'http://localhost:3001',
    },
  },
}))
