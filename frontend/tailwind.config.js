module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        'muted': '#6b7280',
        'bg-soft': '#f6f8fb',
      },
      boxShadow: {
        'card': '0 6px 18px rgba(15,23,42,0.06)',
      }
    },
  },
  plugins: [],
}
