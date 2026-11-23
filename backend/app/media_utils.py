import io
import os
from typing import Optional, Tuple

from PIL import Image, ImageOps

try:
    import rawpy
except ImportError:  # pragma: no cover
    rawpy = None

# Bound maximum image pixels (~100MP) and preview bytes (150MB) to prevent decompression bombs
Image.MAX_IMAGE_PIXELS = 100_000_000
MAX_PREVIEW_BYTES = 150 * 1024 * 1024

RAW_EXTENSIONS = {".nef", ".cr2", ".cr3", ".arw", ".dng", ".orf", ".rw2", ".raw"}
STANDARD_PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff", ".tif"}
HASHABLE_PHOTO_EXTENSIONS = STANDARD_PHOTO_EXTENSIONS | RAW_EXTENSIONS


def open_image_preview(
    path: str,
    ext: str = "",
    grayscale_draft: Optional[Tuple[int, int]] = None,
    rgb_draft: Optional[Tuple[int, int]] = None,
) -> Image.Image:
    """
    Safely opens a standard image or extracts the embedded preview from a RAW file
    (.nef, .cr2, .arw, .dng, etc.), applying EXIF orientation transpose.
    """
    ext_lower = (ext or os.path.splitext(path)[1]).lower()
    if os.path.getsize(path) > MAX_PREVIEW_BYTES and ext_lower not in RAW_EXTENSIONS:
        raise ValueError(f"Image exceeds max preview size ({MAX_PREVIEW_BYTES} bytes)")

    if ext_lower in RAW_EXTENSIONS:
        if rawpy is None:
            raise RuntimeError("rawpy is not installed for RAW preview extraction")
        with rawpy.imread(path) as raw_file:
            thumb = raw_file.extract_thumb()
        thumb_bytes = thumb.data.nbytes if hasattr(thumb.data, "nbytes") else len(thumb.data)
        if thumb_bytes > MAX_PREVIEW_BYTES:
            raise ValueError("RAW embedded thumbnail exceeds maximum allowed bytes")

        if thumb.format == rawpy.ThumbFormat.JPEG:
            with Image.open(io.BytesIO(thumb.data)) as preview:
                if grayscale_draft:
                    preview.draft("L", grayscale_draft)
                elif rgb_draft:
                    # ⚡ Bolt: Use libjpeg DCT downscaling during decode for fast RGB thumbnails (~10x faster on 12MP+)
                    preview.draft("RGB", rgb_draft)
                return ImageOps.exif_transpose(preview).copy()
        if thumb.format == rawpy.ThumbFormat.BITMAP:
            h, w = thumb.data.shape[:2]
            if w * h > Image.MAX_IMAGE_PIXELS:
                raise ValueError("RAW bitmap thumbnail exceeds MAX_IMAGE_PIXELS")
            img = Image.fromarray(thumb.data)
            if grayscale_draft:
                img = img.convert("L")
                img.thumbnail(grayscale_draft, Image.Resampling.BILINEAR)
            elif rgb_draft:
                img.thumbnail(rgb_draft, Image.Resampling.BILINEAR)
            return img
        raise ValueError(f"Unsupported RAW thumbnail format: {thumb.format}")

    with Image.open(path) as img:
        if grayscale_draft:
            img.draft("L", grayscale_draft)
        elif rgb_draft:
            # ⚡ Bolt: Use libjpeg DCT downscaling during decode before exif_transpose (~10x faster on 12MP+ JPEGs)
            img.draft("RGB", rgb_draft)
        return ImageOps.exif_transpose(img).copy()
