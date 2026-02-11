/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./src/**/*.{js,jsx,ts,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                // Bloomberg Core
                bb: {
                    bg: '#000000',
                    panel: '#111111',
                    border: '#333333',
                    text: '#F0F0F0',
                    muted: '#666666',
                    accent: '#FFB400', // Amber for highlights
                    tmux: '#d7d787', // Tmux Bar
                    'ib-orange': '#F5A623',
                    'ib-blue': '#007ACD',
                },
                // Data Colors
                market: {
                    up: '#00FF41',    // Terminal Green
                    down: '#FF3D00',  // Terminal Red/Orange
                    neutral: '#00E5FF', // Cyan
                },
            },
            animation: {
                marquee: 'marquee 180s linear infinite',
            },
            keyframes: {
                marquee: {
                    '0%': { transform: 'translateX(0%)' },
                    '100%': { transform: 'translateX(-100%)' },
                }
            },
            fontFamily: {
                mono: ['"JetBrains Mono"', 'monospace'], // For data/numbers
            },
            fontSize: {
                'xxs': '0.65rem',
            },
            boxShadow: {
                'glow-green': '0 0 5px rgba(0, 255, 65, 0.5)',
                'glow-red': '0 0 5px rgba(255, 61, 0, 0.5)',
            }
        },
    },
    plugins: [],
}
