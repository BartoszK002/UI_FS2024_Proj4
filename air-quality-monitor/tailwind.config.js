/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './src/**/*.{html,js,svelte,ts}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      backgroundColor: {
        'dark-primary': '#1e1e1e',
        'dark-secondary': '#2d2d2d'
      },
      textColor: {
        'dark-text': '#ffffff',
        'dark-muted': '#a0a0a0'
      }
    },
  },
  plugins: [],
}
