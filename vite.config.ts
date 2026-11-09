import { execSync } from 'node:child_process'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// SHA corto (7) del commit desplegado → cabecera X-Lumon-Build.
// Vercel lo expone en VERCEL_GIT_COMMIT_SHA; Netlify en COMMIT_REF; Cloudflare en CF_PAGES_COMMIT_SHA.
// Si no hay ninguno (build local), se lee de git.
function buildSha(): string {
  const fromEnv =
    process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.COMMIT_REF ?? process.env.CF_PAGES_COMMIT_SHA
  if (fromEnv) return fromEnv.slice(0, 7)
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'dev'
  }
}

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  define: {
    // En `npm run dev` siempre "dev" (la API solo lo acepta desde localhost).
    __BUILD_SHA__: JSON.stringify(command === 'serve' ? 'dev' : buildSha()),
  },
}))
