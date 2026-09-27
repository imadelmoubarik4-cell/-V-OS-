"""Real sample media for the S94 Media end-to-end run.

Writes JPG, PNG, WebP and HEIC photos (Pillow + pillow-heif), two H.264 MP4
videos (a short one under 6 MiB and one over 6 MiB for the TUS path) and a
VP9 MP4, with the ffmpeg binary shipped by imageio-ffmpeg:

    pip install pillow pillow-heif imageio-ffmpeg
    python3 make_samples.py OUT_DIR
"""
import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw


def photo(width, height, hue):
    image = Image.new("RGB", (width, height), (hue, 90, 200 - hue // 2))
    draw = ImageDraw.Draw(image)
    for step in range(0, width, 40):
        draw.line([(step, 0), (width - step, height)], fill=(255, 255 - hue, step % 255), width=6)
    draw.rectangle([width // 4, height // 4, width // 2, height // 2], fill=(250, 250, 250))
    return image


def main(out):
    os.makedirs(out, exist_ok=True)
    files = {}
    photo(1600, 1200, 30).save(os.path.join(out, "bar-counter.jpg"), "JPEG", quality=88)
    photo(1200, 1200, 80).save(os.path.join(out, "cocktail-menu.png"), "PNG")
    photo(1080, 1350, 140).save(os.path.join(out, "happy-hour.webp"), "WEBP", quality=85)
    import pillow_heif

    pillow_heif.register_heif_opener()
    photo(2016, 1512, 200).save(os.path.join(out, "iphone-terrace.heic"), "HEIF", quality=80)

    import imageio_ffmpeg

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    base = [ffmpeg, "-y", "-loglevel", "error"]
    # Short clip: 1080x1920, 4 s, with audio, moov first (faststart).
    subprocess.run(base + [
        "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=4",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "30",
        "-c:a", "aac", "-shortest", "-movflags", "+faststart", os.path.join(out, "reel-short.mp4")], check=True)
    # Large clip (> 6 MiB, TUS): noisy source at a high bitrate, moov at the end
    # (like camera files) so the server walks past a large mdat.
    subprocess.run(base + [
        "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=6",
        "-f", "lavfi", "-i", "anoisesrc=d=6",
        "-vf", "noise=alls=60:allf=t",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-b:v", "14M",
        "-c:a", "aac", "-shortest", os.path.join(out, "reel-large.mp4")], check=True)

    # The same short clip as VP9 + Opus in MP4: Playwright's open-source
    # Chromium has no H.264/AAC decoder, so this one proves the browser's
    # poster/thumbnail path there (Chrome and Safari decode H.264).
    subprocess.run(base + [
        "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=4",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-b:v", "1M", "-deadline", "realtime", "-cpu-used", "8",
        "-c:a", "libopus", "-shortest", "-movflags", "+faststart", os.path.join(out, "reel-vp9.mp4")], check=True)

    # Derived copies a browser would make (canvas JPEGs): a thumbnail for every
    # photo, the JPEG publish copy for PNG/WebP/HEIC and a poster frame per video.
    derived = os.path.join(out, "derived")
    os.makedirs(derived, exist_ok=True)
    for name in ["bar-counter.jpg", "cocktail-menu.png", "happy-hour.webp", "iphone-terrace.heic"]:
        image = Image.open(os.path.join(out, name)).convert("RGB")
        thumb = image.copy()
        thumb.thumbnail((480, 480))
        thumb.save(os.path.join(derived, name + ".thumb.jpg"), "JPEG", quality=82)
        if not name.endswith(".jpg"):
            publish = image.copy()
            publish.thumbnail((2048, 2048))
            publish.save(os.path.join(derived, name + ".publish.jpg"), "JPEG", quality=90)
    for name in ["reel-short.mp4", "reel-large.mp4"]:
        subprocess.run(base + ["-ss", "1", "-i", os.path.join(out, name), "-frames:v", "1", "-vf", "scale=-2:720",
                               os.path.join(derived, name + ".poster.jpg")], check=True)
    # Not media at all: an SVG named like a photo (must be refused by content).
    with open(os.path.join(out, "not-a-photo.jpg"), "w", encoding="utf-8") as handle:
        handle.write('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n' * 20)

    for root, _dirs, names in os.walk(out):
        for name in sorted(names):
            path = os.path.join(root, name)
            files[os.path.relpath(path, out)] = os.path.getsize(path)
    print(json.dumps(files))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "samples")
