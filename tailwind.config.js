/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          950: '#08090c',
          900: '#0d0f14',
          850: '#12151c',
          800: '#171b24',
          700: '#212736',
          600: '#2c3447',
        },
        accent: {
          DEFAULT: '#7c5cff',
          soft: '#9d86ff',
          dim: '#5a3fd6',
        },
        track: {
          video: '#3b82f6',
          audio: '#10b981',
          text: '#f59e0b',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
