/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./App.tsx", "./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        paper: "#f3efe6",
        card: "#fffdf8",
        ink: "#1c1915",
        muted: "#6d6458",
        line: "#e4dccb",
        pine: "#0f6e56",
        pineDeep: "#0b5644",
      },
    },
  },
  plugins: [],
};
