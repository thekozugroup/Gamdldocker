import type { Config } from 'tailwindcss'

/*
 * The type ramp mirrors Apple's HIG text styles. Using their names (not t-sm,
 * t-md, t-lg) keeps the intent visible at the call site: a "headline" is a role,
 * a "16px" is a measurement, and roles survive redesigns.
 */
const config: Config = {
  darkMode: ['class'],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    './hooks/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        /*
         * A system stack rather than a webfont: the UI matches the host OS, the
         * first paint has no font swap, and — critically — the build no longer
         * reaches out to Google Fonts, which broke offline and air-gapped
         * builds. The emoji families at the end matter here more than in most
         * apps: playlist names routinely contain emoji, and the previous
         * mono-only stack had no emoji fallback at all.
         */
        sans: [
          '-apple-system', 'BlinkMacSystemFont', '"SF Pro Text"', '"Segoe UI Variable Text"',
          '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', '"Noto Sans"', 'sans-serif',
          '"Apple Color Emoji"', '"Segoe UI Emoji"', '"Noto Color Emoji"',
        ],
        mono: [
          'ui-monospace', '"SF Mono"', 'SFMono-Regular', 'Menlo', '"JetBrains Mono"',
          'Consolas', '"Liberation Mono"', 'monospace',
          '"Apple Color Emoji"', '"Segoe UI Emoji"', '"Noto Color Emoji"',
        ],
      },
      fontSize: {
        'large-title': ['2.125rem', { lineHeight: '2.5rem', letterSpacing: '-0.022em', fontWeight: '700' }],
        title1: ['1.75rem', { lineHeight: '2.125rem', letterSpacing: '-0.021em', fontWeight: '700' }],
        title2: ['1.375rem', { lineHeight: '1.75rem', letterSpacing: '-0.018em', fontWeight: '600' }],
        title3: ['1.25rem', { lineHeight: '1.5rem', letterSpacing: '-0.015em', fontWeight: '600' }],
        headline: ['1.0625rem', { lineHeight: '1.375rem', letterSpacing: '-0.011em', fontWeight: '600' }],
        body: ['1.0625rem', { lineHeight: '1.375rem', letterSpacing: '-0.011em' }],
        callout: ['1rem', { lineHeight: '1.3125rem', letterSpacing: '-0.006em' }],
        subhead: ['0.9375rem', { lineHeight: '1.25rem' }],
        footnote: ['0.8125rem', { lineHeight: '1.125rem' }],
        caption: ['0.75rem', { lineHeight: '1rem' }],
        caption2: ['0.6875rem', { lineHeight: '0.875rem' }],
      },
      spacing: {
        // An 8pt grid with a 4pt half-step. No arbitrary 3.5/2.5 paddings.
        '4.5': '1.125rem',
        '18': '4.5rem',
        rail: '3.5rem',
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar-background))',
          foreground: 'hsl(var(--sidebar-foreground))',
          primary: 'hsl(var(--sidebar-primary))',
          'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
          'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
          border: 'hsl(var(--sidebar-border))',
          ring: 'hsl(var(--sidebar-ring))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 4px)',
        sm: 'calc(var(--radius) - 8px)',
      },
      transitionTimingFunction: {
        hig: 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'none' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s cubic-bezier(0.32, 0.72, 0, 1)',
        'accordion-up': 'accordion-up 0.2s cubic-bezier(0.32, 0.72, 0, 1)',
        'fade-in': 'fade-in 0.24s cubic-bezier(0.32, 0.72, 0, 1)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}

export default config
