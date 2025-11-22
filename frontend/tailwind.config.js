/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      backgroundImage: {
        'loginpage-bg': "url('/login_background.jpg')",
      },
    },
  },
  plugins: [],
};
