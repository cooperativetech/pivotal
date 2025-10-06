import type { Config } from 'tailwindcss'
import animate from 'tailwindcss-animate'

const config = {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    './src/frontend/components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      borderRadius: {
        DEFAULT: 'var(--radius)',
        sm: 'var(--radius-sm)',
        lg: 'var(--radius-lg)',
      },
      fontFamily: {
        sans: 'var(--font-sans)',
      },
      colors: {
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        primary: { DEFAULT: 'var(--primary)', foreground: 'var(--primary-foreground)' },
        secondary: { DEFAULT: 'var(--secondary)', foreground: 'var(--secondary-foreground)' },
        accent: { DEFAULT: 'var(--accent)', foreground: 'var(--accent-foreground)' },
        muted: { DEFAULT: 'var(--muted)', foreground: 'var(--muted-foreground)' },
        card: { DEFAULT: 'var(--card)', foreground: 'var(--card-foreground)' },
      },
      animation: {
        'root-pulse': 'root-pulse 2.6s ease-in-out infinite',
        'timeline-pulse': 'timeline-pulse 500ms ease-out',
      },
      keyframes: {
        'root-pulse': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(95,115,67,0.0)' },
          '50%': { boxShadow: '0 0 0 6px rgba(95,115,67,0.15)' },
        },
        'timeline-pulse': {
          '0%': { boxShadow: '0 0 18px rgba(95,115,67,0.4)', transform: 'scale(1)' },
          '50%': { boxShadow: '0 0 28px rgba(95,115,67,0.55)', transform: 'scale(1.06)' },
          '100%': { boxShadow: '0 0 18px rgba(95,115,67,0.4)', transform: 'scale(1)' },
        },
      },
    },
  },
  plugins: [animate],
} satisfies Config

export default config
