import sys
from pathlib import Path
import struct


if len(sys.argv) != 3:
    raise SystemExit("usage: build-opal-ico.py <iconset-dir> <output-ico>")

iconset = Path(sys.argv[1])
output = Path(sys.argv[2])
entries = [
    (16, iconset / 'icon_16x16.png'),
    (32, iconset / 'icon_32x32.png'),
    (64, iconset / 'icon_32x32@2x.png'),
    (128, iconset / 'icon_128x128.png'),
    (256, iconset / 'icon_256x256.png'),
]

missing = [path for _, path in entries if not path.is_file()]
if missing:
    raise SystemExit("missing iconset files: " + ", ".join(str(path) for path in missing))

payloads = [(size, path.read_bytes()) for size, path in entries]
header_size = 6 + (16 * len(payloads))
offset = header_size

with output.open('wb') as handle:
    handle.write(struct.pack('<HHH', 0, 1, len(payloads)))
    for size, data in payloads:
        dimension = 0 if size == 256 else size
        handle.write(struct.pack('<BBBBHHII', dimension, dimension, 0, 0, 1, 32, len(data), offset))
        offset += len(data)
    for _, data in payloads:
        handle.write(data)
