/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Outfit', 'Satoshi', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors: {
        tint: {
          bg: '#1E1F22',
          surface: '#2B2D31',
          card: '#313338',
          muted: '#B5BAC1',
          text: '#DBDEE1',
          accent: '#FF6B1A',
          accentHover: '#FF8A3D',
          accentDark: '#C4520A',
          success: '#23A55A',
        },
      },
      boxShadow: {
        // Resplandor cálido del acento: hover de primarios y elementos activos.
        glow: '0 10px 34px -10px rgba(255, 107, 26, 0.55), 0 0 0 1px rgba(255, 138, 61, 0.25)',
        // Elevación suave de tarjetas al pasar el puntero.
        lift: '0 24px 48px -24px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.06)',
      },
      backgroundImage: {
        'accent-sheen': 'linear-gradient(135deg, #FF8A3D 0%, #FF6B1A 45%, #E85A0F 100%)',
        noise:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
      },
    },
  },
  plugins: [],
};
