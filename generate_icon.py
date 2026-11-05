"""Generate a modern colorful 64x64 32-bit RGBA .ico file using only the Python standard library."""
import os
import math
import struct


def create_app_icon(filepath='app_icon.ico', size=64):
    pixels = bytearray(size * size * 4)

    for y in range(size):
        # BMP in ICO is stored bottom-up
        row_y = size - 1 - y
        for x in range(size):
            idx = (row_y * size + x) * 4

            # Rounded rectangle SDF
            cx, cy = (size - 1) / 2.0, (size - 1) / 2.0
            half = (size / 2.0) - 2.0
            radius = 14.0
            dx = max(abs(x - cx) - (half - radius), 0.0)
            dy = max(abs(y - cy) - (half - radius), 0.0)
            dist = math.hypot(dx, dy) - radius

            if dist > 0.8:
                pixels[idx:idx+4] = b'\x00\x00\x00\x00'
                continue

            alpha = 255 if dist < -0.5 else int(255 * (0.8 - dist) / 1.3)

            # Diagonal vibrant gradient: Indigo (#4f46e5) -> Violet (#8b5cf6) -> Cyan (#06b6d4)
            t = (x + y) / float(2 * size)
            if t < 0.5:
                u = t * 2.0
                r = int(79 * (1 - u) + 139 * u)
                g = int(70 * (1 - u) + 92 * u)
                b = int(229 * (1 - u) + 246 * u)
            else:
                u = (t - 0.5) * 2.0
                r = int(139 * (1 - u) + 6 * u)
                g = int(92 * (1 - u) + 182 * u)
                b = int(246 * (1 - u) + 212 * u)

            # Draw a crisp white graduation cap emblem in the center
            nx = (x - cx) / (size * 0.34)
            ny = (y - (cy - 2)) / (size * 0.34)

            # Diamond top of cap: |nx| * 0.55 + |ny + 0.15| < 0.48
            in_cap_top = (abs(nx) * 0.52 + abs(ny + 0.18)) < 0.45
            # Cap base / skullcap beneath diamond
            in_cap_base = (abs(nx) < 0.42) and (0.12 <= ny <= 0.46) and ((ny - abs(nx) * 0.25) > 0.08)
            # Tassel on the right
            in_tassel = (0.68 <= nx <= 0.78) and (-0.12 <= ny <= 0.48)

            if in_cap_top or in_cap_base or in_tassel:
                if in_tassel and ny > 0.30:
                    # Golden tassel tip (#fbbf24)
                    r, g, b = 251, 191, 36
                else:
                    r, g, b = 255, 255, 255

            # BGRA order for ICO/BMP
            pixels[idx] = b
            pixels[idx + 1] = g
            pixels[idx + 2] = r
            pixels[idx + 3] = alpha

    mask_row_bytes = ((size + 31) // 32) * 4
    and_mask = bytes(mask_row_bytes * size)

    bih = struct.pack(
        '<IIIHHIIIIII',
        40,                 # biSize
        size,               # biWidth
        size * 2,           # biHeight (XOR + AND)
        1,                  # biPlanes
        32,                 # biBitCount
        0,                  # biCompression (BI_RGB)
        len(pixels) + len(and_mask),
        0, 0, 0, 0
    )

    image_data = bih + bytes(pixels) + and_mask
    ico_header = struct.pack('<HHH', 0, 1, 1)
    ico_dir_entry = struct.pack(
        '<BBBBHHII',
        size if size < 256 else 0,
        size if size < 256 else 0,
        0,
        0,
        1,
        32,
        len(image_data),
        6 + 16
    )

    with open(filepath, 'wb') as f:
        f.write(ico_header + ico_dir_entry + image_data)


if __name__ == '__main__':
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'app_icon.ico')
    create_app_icon(out)
    print(f"Generated {out}")
