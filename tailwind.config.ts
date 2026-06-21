import type { Config } from "tailwindcss";
import { heroui } from "@heroui/react";

const config: Config = {
  content: [
    // 1. Scan your app files
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    
    // 2. Scan the HeroUI package (CRITICAL FOR MODALS)
    "./node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  darkMode: "class",
  plugins: [
    heroui({
      themes: {
        light: {
          colors: {
            background: "#F4F5FA",
            content1:   "#FFFFFF",
            content2:   "#EEF0F8",
            content3:   "#E4E6F2",
            divider:    "#DDE0EE",
          },
        },
        dark: {
          colors: {
            background: "#0C0E14",
            content1:   "#141820",
            content2:   "#1C2030",
            content3:   "#242840",
            divider:    "#2A2F45",
          },
        },
      },
    }),
  ],
};

export default config;