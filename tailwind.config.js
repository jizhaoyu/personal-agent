/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ambi: {
          ground: '#f7f4ec',
          panel: '#efeadd',
          ink: '#23293a',
          muted: '#6b7183',
          accent: '#a8681a',
          hairline: '#ddd5c2',
        }
      },
      boxShadow: {
        'float': '0 8px 30px rgba(0, 0, 0, 0.12)',
        'pill': '0 4px 20px rgba(0, 0, 0, 0.08)',
      }
    },
  },
  plugins: [],
}
