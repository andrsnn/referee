"""Render each page of a PDF to a JPEG: pdf2png.py <pdf> <outdir> <base> <maxwidth>. Prints one path per page."""
import sys
import pymupdf as fitz
pdf, out, base, maxw = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
doc = fitz.open(pdf)
for i, page in enumerate(doc):
    zoom = min(3.0, maxw / page.rect.width)
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
    path = f"{out}/{base}_p{i + 1:02d}.jpg"
    pix.save(path, jpg_quality=88)
    print(path)
