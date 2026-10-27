import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  envPrefix: ['VITE_', 'BACKEND_URL'],
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg'] }
});
