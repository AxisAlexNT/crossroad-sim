#!/usr/bin/env bash
# Пересобрать подмножества шрифта DejaVu Sans (латиница + кириллица) для экспорта PDF.
# Нужен pyftsubset: pip install fonttools
set -euo pipefail
cd "$(dirname "$0")/.."
U="U+0020-007E,U+00A0-00FF,U+0400-045F,U+2010-2027,U+2030-205E,U+2100-21FF,U+2212,U+2264,U+2265,U+2248,U+00B0,U+2116,U+25A0-25FF,U+2190-21FF"
for w in "" "-Bold"; do
  pyftsubset "node_modules/dejavu-fonts-ttf/ttf/DejaVuSans$w.ttf" --unicodes="$U" \
    --output-file="src/assets/fonts/DejaVuSans$w-subset.ttf"
done
