"""Download offline copies of the UI libraries into ./vendor so the released app works without internet.
Run automatically by build_release.bat. Safe to re-run."""
import os
import urllib.request

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vendor')
FA = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2'
FILES = {
    'tailwind.js': 'https://cdn.tailwindcss.com/3.4.5',
    'wavesurfer.min.js': 'https://cdn.jsdelivr.net/npm/wavesurfer.js@7.8.6/dist/wavesurfer.min.js',
    'fontawesome/css/all.min.css': f'{FA}/css/all.min.css',
    'fontawesome/webfonts/fa-solid-900.woff2': f'{FA}/webfonts/fa-solid-900.woff2',
    'fontawesome/webfonts/fa-regular-400.woff2': f'{FA}/webfonts/fa-regular-400.woff2',
    'fontawesome/webfonts/fa-brands-400.woff2': f'{FA}/webfonts/fa-brands-400.woff2',
    'fontawesome/webfonts/fa-v4compatibility.woff2': f'{FA}/webfonts/fa-v4compatibility.woff2',
    'fonts/PlusJakartaSans.woff2': 'https://cdn.jsdelivr.net/fontsource/fonts/plus-jakarta-sans:vf@latest/latin-wght-normal.woff2',
    'fonts/JetBrainsMono.woff2': 'https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono:vf@latest/latin-wght-normal.woff2',
}
FONTS_CSS = """@font-face { font-family: 'Plus Jakarta Sans'; font-style: normal; font-display: swap; font-weight: 200 800; src: url('PlusJakartaSans.woff2') format('woff2'); }
@font-face { font-family: 'JetBrains Mono'; font-style: normal; font-display: swap; font-weight: 100 800; src: url('JetBrainsMono.woff2') format('woff2'); }
"""


def main():
    ok = True
    for rel, url in FILES.items():
        dest = os.path.join(BASE, *rel.split('/'))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            print(f'  [cached] {rel}')
            continue
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 StudyHubBuilder'})
            with urllib.request.urlopen(req, timeout=60) as r, open(dest, 'wb') as f:
                f.write(r.read())
            print(f'  [ok]     {rel}')
        except Exception as e:
            ok = False
            print(f'  [FAIL]   {rel}: {e}')
    with open(os.path.join(BASE, 'fonts', 'fonts.css'), 'w', encoding='utf-8') as f:
        f.write(FONTS_CSS)
    print('Vendor libraries ready.' if ok else 'Some downloads failed - the app will fall back to the online CDN for those.')


if __name__ == '__main__':
    main()
