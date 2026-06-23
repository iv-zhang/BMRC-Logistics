import type { Config } from "tailwindcss";
import { heroui } from "@heroui/react";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-hanken-grotesk)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "monospace"],
      },
    },
  },
  darkMode: "class",
  plugins: [
    heroui({
      themes: {
        light: {
          colors: {
            background: "#EEF0F4",
            content1:   "#FFFFFF",
            content2:   "#F9FAFB",
            content3:   "#F2F4F7",
            divider:    "#E4E7EC",
            foreground: {
              DEFAULT: "#101828",
              500: "#475569",
              400: "#667085",
              300: "#98A2B3",
            },
          },
        },
        dark: {
          colors: {
            background: "#0C0E14",
            content1:   "#141820",
            content2:   "#1C2030",
            content3:   "#242840",
            divider:    "#2A2F45",
            foreground: {
              DEFAULT: "#EEF2F8",
              500: "#C2CCDA",
              400: "#9AA7BD",
              300: "#6F7E96",
            },
          },
        },
      },
    }),
  ],
};
export default config;
