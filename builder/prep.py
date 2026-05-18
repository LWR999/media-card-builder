"""bentley_media_prep processing logic.

Applies to each album directory after files are copied:
- Resize embedded FLAC cover art (800px max, JPEG quality 95)
- Tag _ prefix folders as compilations
- Remove Mac detritus (.DS_Store, ._* files)
- Strip extended attributes (xattr -cr equivalent)
"""
import os
import subprocess
from io import BytesIO
from pathlib import Path

from mutagen.flac import FLAC, Picture
from PIL import Image

MAX_WIDTH = 500
JPEG_QUALITY = 95
MAC_DETRITUS = {".DS_Store", ".Spotlight-V100", ".Trashes", ".fseventsd"}


def _normalize_for_jpeg(img: Image.Image) -> Image.Image:
    if img.mode in ("RGBA", "LA", "P"):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        if img.mode == "P":
            img = img.convert("RGBA")
        bg.paste(img, mask=img.split()[-1] if img.mode in ("RGBA", "LA") else None)
        return bg
    if img.mode != "RGB":
        return img.convert("RGB")
    return img


def _resize_image(img: Image.Image, max_width: int) -> Image.Image:
    w, h = img.size
    if w <= max_width:
        return img
    new_h = round(h * (max_width / w))
    return img.resize((max_width, new_h), Image.Resampling.LANCZOS)


def _process_flac_art(flac_path: Path, max_width: int = MAX_WIDTH) -> bytes | None:
    """Resize embedded art in a FLAC file in-place. Returns raw JPEG bytes of first image."""
    try:
        audio = FLAC(str(flac_path))
    except Exception:
        return None

    pictures = audio.pictures
    if not pictures:
        return None

    first_jpeg_bytes = None
    new_pictures = []

    for pic in pictures:
        try:
            img = Image.open(BytesIO(pic.data))
            img = _resize_image(img, max_width)
            img_rgb = _normalize_for_jpeg(img)
            buf = BytesIO()
            img_rgb.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
            jpeg_bytes = buf.getvalue()

            new_pic = Picture()
            new_pic.type = pic.type
            new_pic.mime = "image/jpeg"
            new_pic.desc = pic.desc
            new_pic.width = img_rgb.width
            new_pic.height = img_rgb.height
            new_pic.depth = 24
            new_pic.data = jpeg_bytes
            new_pictures.append(new_pic)

            if first_jpeg_bytes is None:
                first_jpeg_bytes = jpeg_bytes
        except Exception:
            new_pictures.append(pic)

    audio.clear_pictures()
    for p in new_pictures:
        audio.add_picture(p)
    try:
        audio.save()
    except Exception:
        pass

    return first_jpeg_bytes


def _tag_compilation(flac_path: Path, album_name: str):
    try:
        audio = FLAC(str(flac_path))
        audio["ALBUM"] = album_name
        audio["ALBUMARTIST"] = "Various Artists"
        audio["COMPILATION"] = "1"
        audio.save()
    except Exception:
        pass


def _remove_mac_detritus(directory: Path):
    for root, dirs, files in os.walk(directory):
        root_path = Path(root)
        for fname in files:
            if fname.startswith("._") or fname in MAC_DETRITUS:
                try:
                    (root_path / fname).unlink()
                except OSError:
                    pass
        dirs[:] = [d for d in dirs if d not in MAC_DETRITUS]


def _strip_xattrs(directory: Path):
    try:
        subprocess.run(
            ["xattr", "-cr", str(directory)],
            capture_output=True,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass


def process_album_directory(dest_dir: Path, log=None, resize_artwork: bool = True) -> dict:
    """Clean and optionally process a copied album directory.

    resize_artwork should only be True for device profiles that need it
    (e.g. bentley). Skipping it avoids a full read+rewrite pass of every
    FLAC file, which is the dominant cost for large builds.
    """
    def _log(msg):
        if log:
            log(msg)

    folder_name = dest_dir.name
    is_compilation = folder_name.startswith("_")
    album_name = folder_name[1:] if is_compilation else folder_name

    processed = 0

    if is_compilation or resize_artwork:
        flac_files = sorted(dest_dir.glob("*.flac"))
        for sub in sorted(dest_dir.iterdir()):
            if sub.is_dir() and not sub.name.startswith("."):
                flac_files += sorted(sub.glob("*.flac"))

        for flac_path in flac_files:
            if is_compilation:
                _tag_compilation(flac_path, album_name)
            if resize_artwork:
                _process_flac_art(flac_path)
            processed += 1

    _remove_mac_detritus(dest_dir)
    _strip_xattrs(dest_dir)

    _log(f"  Processed {processed} FLACs, compilation={is_compilation}, resize_art={resize_artwork}")
    return {"flacs_processed": processed, "is_compilation": is_compilation}
