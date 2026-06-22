/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg:      "#07090e",
        surface: "#0c0f16",
        panel:   "#10141d",
        card:    "#141924",
        rim:     "#1d2537",
        wire:    "#28344a",
        ink:     "#dde4f0",
        muted:   "#5a6a85",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      boxShadow: {
        glow:     "0 0 24px rgba(34,211,238,0.12), 0 0 80px rgba(34,211,238,0.04)",
        "glow-v": "0 0 24px rgba(167,139,250,0.12), 0 0 80px rgba(167,139,250,0.04)",
        panel:    "0 0 0 1px rgba(34,211,238,0.06), 0 8px 40px rgba(0,0,0,0.6)",
      },
      animation: {
        "spin-slow":  "spin 2.5s linear infinite",
        "pulse-ring": "pulse-ring 1.8s ease-out infinite",
      },
      keyframes: {
        "pulse-ring": {
          "0%":   { transform: "scale(1)", opacity: "0.6" },
          "100%": { transform: "scale(2.2)", opacity: "0" },
        },
      },
    },
  },
  plugins: [],
};
