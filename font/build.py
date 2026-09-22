"""Build a 938 correspondence face from repeated printed impressions.

Run with `uv run --locked python build.py` from this directory. Poppler's
`pdftoppm` must be on PATH. The source is the MIT typefaces PDF in references/,
pages 19 and 31. Page 19 identifies the element and prints all 88 positions;
page 31 supplies the CTSS graphics test and supplementary glyphs. The archive
face preserves one impression per character; the main face preserves clear
page-31 counters and uses repeated impressions to repair supported dropouts.
"""

from __future__ import annotations

import hashlib
import json
import string
import subprocess
import tempfile
import unicodedata
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen


HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent / "references" / "IBM-938-standard-correspondence-typefaces.pdf"
SOURCE_SHA256 = "8f80dad360c29d2f9afe507306998747cc194c1ed2306ef7b3f04497f286b4e2"
SCALE = 20  # 300 dpi scan pixels to font units; 30 pixels = 600-unit pitch.
ADVANCE = 600
SAMPLE_WIDTH = 40
SAMPLE_HEIGHT = 80
SAMPLE_BASELINE = 60

# The page-31 proof is rotated very slightly in the scan: the printed baseline
# falls about four pixels over the 25 intervals from A to Z. Correct that page
# geometry before treating the impressions as type-element geometry.
PROOF_ROW_BASELINE_STEP = 4 / 25

# The eight rows printed on page 19 are the actual 938 element's two shifts.
# Comma and period each occupy two positions. The 88 positions therefore have
# 86 distinct impressions. Space moves the carrier and is not on the element.
LAYOUT_ROWS = (
    "=◇;:%'\"*()_+",
    "1234567890-&",
    "QWERTYUIOP¢",
    "qwertyuiop@",
    "ASDFGHJKL!±",
    "asdfghjkl$#",
    "ZXCVBNM,.?",
    "zxcvbnm,./",
)
assert sum(map(len, LAYOUT_ROWS)) == 88
CORE = "".join(dict.fromkeys("".join(LAYOUT_ROWS)))
assert len(CORE) == 86

# Bounding rows and registered print baselines of the page-19 element proof at
# 300 dpi. They are measured against the clearer page-31 strikes; the bottom
# of a crop is not necessarily the typewriter baseline, especially for rows
# containing descenders.
LAYOUT_METRICS = (
    (545, 601, 589), (598, 648, 638),
    (691, 741, 736), (739, 791, 780),
    (840, 892, 884), (890, 941, 931),
    (982, 1035, 1022), (1033, 1085, 1069),
)
LAYOUT_X = 534
LAYOUT_PITCH = 28.5
LAYOUT_X_OFFSETS = (0, 0, -1, 0, 1, 1, 6, 6)

# The second 938 impression is less congested and gives cleaner alphabetic
# outlines. Its glyphs are traced for the main face; page 19 supplies the
# three signs absent from that general-purpose CTSS graphics test.
ROWS = {
    "lower": (730, 788, 773, string.ascii_lowercase),
    "digits": (882, 930, 923, "1234567890"),
    "upper": (1034, 1085, 1077, string.ascii_uppercase),
}

# The order of the special-character lines on page 31, from top to bottom.
PROOF_SYMBOLS = [
    "=", "'", "+", ".", ")", ":", "-", "$", "*", "/", ",", "(",
    "|", "]", "^", ";", "#", "¬", "@", "%", "!", "&", "~", '"',
    "_", "<", "[", ">", "?", "`", "{", "}",
]

# Vertical bounds of the explanatory text beside each printed symbol.
# These give the line centers and baselines without including the text itself.
SYMBOL_LINES = [
    (1190, 1231), (1239, 1280), (1290, 1330), (1340, 1380),
    (1391, 1432), (1443, 1478), (1492, 1533), (1543, 1585),
    (1594, 1629), (1644, 1679), (1704, 1729), (1746, 1784),
    (1794, 1831), (1847, 1887), (1897, 1934), (1948, 1983),
    (1999, 2040), (2049, 2091), (2100, 2135), (2150, 2192),
    (2200, 2235), (2251, 2288), (2299, 2334), (2350, 2388),
    (2398, 2435), (2450, 2483), (2507, 2536), (2548, 2587),
    (2597, 2634), (2651, 2686), (2699, 2737), (2747, 2782),
]
assert len(PROOF_SYMBOLS) == len(SYMBOL_LINES) == 32

# Printed explanatory labels on page 31. Crossed-out text is not sampled.
# The labels begin two character positions after the isolated symbol.
SYMBOL_LABELS = (
    "equal sign", "close quote or apostrophe", "plus sign", "period",
    "close parenthesis", "colon", "minus sign", "dollar sign",
    "asterisk", "slash", "comma", "open parenthesis", None,
    "close square bracket", None, "semicolon", "number sign", None,
    "commercial at sign", "percent sign", "exclamation point",
    "ampersand", "tilde", "double quote", "underbar", "less than sign",
    "open square bracket", "greater than sign", "question mark",
    "open quote", "open brace", "close brace",
)
assert len(SYMBOL_LABELS) == len(SYMBOL_LINES)

def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_proof(page: int) -> np.ndarray:
    if sha256(SOURCE) != SOURCE_SHA256:
        raise ValueError("The typeface reference PDF changed; recalibrate the scan first")
    with tempfile.TemporaryDirectory(prefix="ctss-font-") as scratch:
        prefix = Path(scratch) / "proof"
        subprocess.run(
            ["pdftoppm", "-f", str(page), "-l", str(page), "-r", "300", "-gray",
             "-singlefile", str(SOURCE), str(prefix)],
            check=True,
            capture_output=True,
        )
        image = np.asarray(Image.open(prefix.with_suffix(".pgm")).convert("L"))
    if image.shape != (3300, 2542):
        raise ValueError(f"Unexpected proof dimensions: {image.shape}")
    return image < 128


def remove_specks(mask: np.ndarray, min_area: int = 3) -> np.ndarray:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(
        mask.astype(np.uint8), connectivity=8
    )
    cleaned = np.zeros_like(mask, dtype=np.uint8)
    for label in range(1, count):
        if stats[label, cv2.CC_STAT_AREA] >= min_area:
            cleaned[labels == label] = 1
    return cleaned


def prepare_mask(mask: np.ndarray) -> np.ndarray:
    """Remove isolated scan noise and bridge only one-pixel ink gaps."""
    clean = remove_specks(mask)
    clean = cv2.morphologyEx(
        clean, cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3)),
    )
    return cv2.medianBlur(clean, 3)


def trace(mask: np.ndarray, origin_x: int, origin_y: int,
          cell_x: int, baseline: int, scale_x: float = SCALE,
          already_clean: bool = False,
          ) -> list[list[tuple[int, int]]]:
    """Vectorize source pixels; keep holes as opposite-winding contours."""
    clean = mask if already_clean else prepare_mask(mask)
    enlarged = cv2.resize(clean * 255, None, fx=4, fy=4,
                          interpolation=cv2.INTER_CUBIC)
    smooth = cv2.GaussianBlur(enlarged, (7, 7), 1.2)
    binary = (smooth >= 128).astype(np.uint8)
    contours, _ = cv2.findContours(binary, cv2.RETR_TREE,
                                   cv2.CHAIN_APPROX_SIMPLE)
    result = []
    for contour in contours:
        if cv2.contourArea(contour) < 8:
            continue
        simplified = cv2.approxPolyDP(contour, 1.6, True)[:, 0, :]
        if len(simplified) < 3:
            continue
        points = [
            (round((origin_x + px / 4 - cell_x) * scale_x),
             round((baseline - origin_y - py / 4) * SCALE))
            for px, py in simplified
        ]
        result.append(points)
    return result


def centered(contours: list) -> list:
    """Discard one specimen's carrier offset, retaining its printed shape."""
    if not contours:
        return contours
    xs = [x for contour in contours for x, _ in contour]
    dx = round((ADVANCE - min(xs) - max(xs)) / 2)
    return [[(x + dx, y) for x, y in contour] for contour in contours]


def vertically_registered(contours: list, anchor: list) -> list:
    """Keep consensus repair from moving a glyph off its proof registration."""
    if not contours or not anchor:
        return contours
    ys = [y for contour in contours for _, y in contour]
    anchor_ys = [y for contour in anchor for _, y in contour]
    dy = round((min(anchor_ys) + max(anchor_ys) - min(ys) - max(ys)) / 2)
    return [[(x, y + dy) for x, y in contour] for contour in contours]


def proof_row_vertical_offset(char: str) -> int:
    """Undo page-31's scan slope without changing impression matching."""
    for row in (string.ascii_lowercase, string.digits, string.ascii_uppercase):
        if char in row:
            return round(row.index(char) * PROOF_ROW_BASELINE_STEP * SCALE)
    return 0


def shifted_vertically(contours: list, dy: int) -> list:
    return [[(x, y + dy) for x, y in contour] for contour in contours]


def layout_impressions(proof: np.ndarray):
    for row, (chars, (top, bottom, baseline)) in enumerate(
        zip(LAYOUT_ROWS, LAYOUT_METRICS)
    ):
        for index, char in enumerate(chars):
            left = round(LAYOUT_X + LAYOUT_X_OFFSETS[row] + index * LAYOUT_PITCH)
            right = round(LAYOUT_X + LAYOUT_X_OFFSETS[row] + (index + 1) * LAYOUT_PITCH)
            yield char, proof[top:bottom, left:right], left, top, baseline, (
                f"layout:{row}:{index}"
            )


def trace_layout(proof: np.ndarray) -> dict[str, list]:
    glyphs = {}
    for char, mask, left, top, baseline, _ in layout_impressions(proof):
        if char in glyphs:  # The repeated comma and period use one outline.
            continue
        glyphs[char] = centered(trace(
            mask, left, top, left, baseline,
            scale_x=ADVANCE / LAYOUT_PITCH,
        ))
    return glyphs


def alphanumeric_impressions(proof: np.ndarray):
    for name, (top, bottom, baseline, chars) in ROWS.items():
        for index, char in enumerate(chars):
            left = 900 + index * 30
            yield char, proof[top:bottom, left:left + 30], left, top, baseline, (
                f"graphics:{name}:{index}"
            )


def trace_alphanumerics(proof: np.ndarray) -> dict[str, list]:
    glyphs = {}
    for char, mask, left, top, baseline, _ in alphanumeric_impressions(proof):
        contours = centered(trace(mask, left, top, left, baseline))
        glyphs[char] = shifted_vertically(
            contours, proof_row_vertical_offset(char)
        )
    return glyphs


def isolated_symbols(proof: np.ndarray):
    # Segment the isolated first-column impressions once. Assign each ink
    # component to its nearest explanatory line, so punctuation dots and the
    # low underscore remain attached to the correct printed character.
    left, right, top, bottom = 890, 936, 1180, 2800
    region = proof[top:bottom, left:right].astype(np.uint8)
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(
        region, connectivity=8
    )
    centers = [(a + b) / 2 for a, b in SYMBOL_LINES]
    assigned = [np.zeros_like(region) for _ in PROOF_SYMBOLS]
    for label in range(1, count):
        area = stats[label, cv2.CC_STAT_AREA]
        if area < 3 or stats[label, cv2.CC_STAT_WIDTH] > 43:
            continue
        center_y = top + centroids[label, 1]
        index = min(range(len(centers)), key=lambda i: abs(center_y - centers[i]))
        if abs(center_y - centers[index]) <= 38:
            assigned[index][labels == label] = 1
    for index, char in enumerate(PROOF_SYMBOLS):
        baseline = SYMBOL_LINES[index][1] - 4
        yield char, assigned[index], left, top, baseline, f"graphics:symbol:{index}"


def trace_symbols(proof: np.ndarray) -> dict[str, list]:
    glyphs = {}
    for char, mask, left, top, baseline, _ in isolated_symbols(proof):
        glyphs[char] = centered(trace(mask, left, top, 900, baseline))
    return glyphs


def label_impressions(proof: np.ndarray):
    for line, label in enumerate(SYMBOL_LABELS):
        if label is None:
            continue
        top, bottom = SYMBOL_LINES[line]
        baseline = bottom - 4
        for index, char in enumerate(label):
            if char == " ":
                continue
            left = 960 + index * 30
            yield char, proof[top:bottom, left:left + 30], left, top, baseline, (
                f"graphics:label:{line}:{index}"
            )


def normalized_sample(mask: np.ndarray, top: int, baseline: int,
                      pitch: float, preserve_gaps: bool = False) -> np.ndarray:
    """Register an ink cell on a common baseline without its carrier offset."""
    # Symbols often contain intentionally narrow white gaps. Morphological
    # closing merges the two bars of =, the ! dot, and the stems of # and ±.
    # The smallest genuine detached symbol mark in the isolated proof is the
    # question-mark dot (43 pixels). Eleven pixels removes scan flecks without
    # approaching that mark, while leaving the original stroke gaps intact.
    clean = remove_specks(mask, min_area=11) if preserve_gaps else prepare_mask(mask)
    ys, xs = np.nonzero(clean)
    if len(xs) == 0:
        return np.zeros((SAMPLE_HEIGHT, SAMPLE_WIDTH), dtype=np.uint8)
    horizontal_scale = 30 / pitch
    mid_x = (int(xs.min()) + int(xs.max()) + 1) / 2
    transform = np.float32([
        [horizontal_scale, 0, SAMPLE_WIDTH / 2 - mid_x * horizontal_scale],
        [0, 1, SAMPLE_BASELINE - (baseline - top)],
    ])
    return cv2.warpAffine(
        clean, transform, (SAMPLE_WIDTH, SAMPLE_HEIGHT),
        flags=cv2.INTER_NEAREST,
    )


def overlap(a: np.ndarray, b: np.ndarray) -> float:
    ink = int(a.sum()) + int(b.sum())
    return 2 * int(np.count_nonzero(a & b)) / ink if ink else 0


def register(sample: np.ndarray, reference: np.ndarray) -> tuple[np.ndarray, float]:
    best = sample
    score = overlap(sample, reference)
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            if dx == dy == 0:
                continue
            shifted = cv2.warpAffine(
                sample, np.float32([[1, 0, dx], [0, 1, dy]]),
                (SAMPLE_WIDTH, SAMPLE_HEIGHT), flags=cv2.INTER_NEAREST,
            )
            match = overlap(shifted, reference)
            if match > score:
                best, score = shifted, match
    return best, score


def combine_samples(samples: list[np.ndarray]) -> np.ndarray:
    """Use the median ink boundary, rather than a single strike's dropouts."""
    fields = [
        cv2.distanceTransform(mask, cv2.DIST_L2, 3)
        - cv2.distanceTransform(1 - mask, cv2.DIST_L2, 3)
        for mask in samples
    ]
    combined = (np.median(fields, axis=0) > 0).astype(np.uint8)
    if len(samples) > 1:
        # Restore a short break only where another impression actually has
        # ink. The closing mask bounds the repair so it cannot add a new spur.
        near_stroke = cv2.morphologyEx(
            combined, cv2.MORPH_CLOSE, np.ones((5, 5), dtype=np.uint8)
        )
        corroborated = np.bitwise_or.reduce(samples)
        combined |= corroborated & near_stroke
    return remove_specks(combined)


def reconstruct_glyph(char: str, samples: list[np.ndarray],
                      anchor: np.ndarray) -> np.ndarray:
    """Keep the isolated symbol proof when its only peer is over-inked.

    The page-19 layout is markedly heavier than the page-31 graphics proof.
    Averaging just two symbol impressions can fill the equal-sign gap or the
    percent-sign bowls. Letters and digits still benefit from the layout's
    corroborating ink where the page-31 proof has a dropout.
    """
    if len(samples) == 2 and char not in string.ascii_letters + string.digits:
        reconstructed = anchor.copy()
    else:
        reconstructed = combine_samples(samples)
    if char == "±":
        # Its only, heavily inked impression joins the plus stem to the
        # minus bar at a narrow neck. Separation is an inference from the
        # identified sign, not corroborated by a second 938 strike.
        reconstructed[42:44, :] = 0
    return reconstructed


def consensus_glyphs(layout: np.ndarray, proof: np.ndarray) -> tuple[dict, dict]:
    """Combine matching impressions; never infer persistent element damage."""
    samples: dict[str, list[tuple[str, np.ndarray]]] = {}

    def add(impressions, pitch: float):
        for char, mask, _, top, baseline, source in impressions:
            if char not in CORE:
                continue
            registered = normalized_sample(
                mask, top, baseline, pitch,
                preserve_gaps=char not in string.ascii_letters + string.digits,
            )
            if registered.any():
                samples.setdefault(char, []).append((source, registered))

    add(layout_impressions(layout), LAYOUT_PITCH)
    add(alphanumeric_impressions(proof), 30)
    add(isolated_symbols(proof), 30)
    add(label_impressions(proof), 30)

    glyphs = {}
    evidence = {}
    for char in CORE:
        candidates = samples[char]
        # The isolated proof character is the anchor; it is not automatically
        # the final outline. Label cells with poor correspondence are rejected.
        anchor = next((mask for source, mask in candidates
                       if source.startswith("graphics:") and ":label:" not in source),
                      candidates[0][1])
        accepted = []
        aligned_anchor = None
        sources = []
        for source, sample in candidates:
            aligned, score = register(sample, anchor)
            if sample is anchor or score >= 0.55:
                accepted.append(aligned)
                sources.append(source)
                if sample is anchor:
                    aligned_anchor = aligned
        if not accepted:
            raise ValueError(f"No usable impressions for {char!r}")
        if aligned_anchor is None:
            raise ValueError(f"Missing anchor impression for {char!r}")
        combined = reconstruct_glyph(char, accepted, aligned_anchor)
        contours = centered(trace(
            combined, 0, 0, 0, SAMPLE_BASELINE, already_clean=True,
        ))
        anchor_contours = centered(trace(
            aligned_anchor, 0, 0, 0, SAMPLE_BASELINE, already_clean=True,
        ))
        registered = vertically_registered(contours, anchor_contours)
        glyphs[char] = shifted_vertically(
            registered, proof_row_vertical_offset(char)
        )
        if not glyphs[char]:
            raise ValueError(f"Consensus lost the outline for {char!r}")
        evidence[char] = sources
    return glyphs, evidence


def rectangle(x0: int, y0: int, x1: int, y1: int) -> list:
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def shifted(contours: list, dx: int = 0, dy: int = 0) -> list:
    return [[(x + dx, y + dy) for x, y in contour] for contour in contours]


ACCENTS = {
    "\u0300": [[(165, 870), (225, 870), (380, 760), (315, 760)]],
    "\u0301": [[(375, 870), (435, 870), (285, 760), (220, 760)]],
    "\u0302": [[(150, 785), (285, 900), (420, 785), (390, 750),
                 (285, 840), (180, 750)]],
    "\u0303": [[(135, 795), (220, 860), (315, 800), (400, 865),
                 (445, 830), (315, 745), (220, 805), (165, 755)]],
    "\u0304": [rectangle(125, 765, 475, 805)],
    "\u0306": [[(135, 855), (180, 805), (300, 770), (420, 805),
                 (465, 855), (440, 770), (300, 725), (160, 770)]],
    "\u0307": [rectangle(275, 765, 325, 820)],
    "\u0308": [rectangle(175, 765, 225, 820), rectangle(375, 765, 425, 820)],
    "\u030A": [[(300, 900), (390, 840), (360, 755), (300, 725),
                 (240, 755), (210, 840)],
                [(300, 840), (270, 815), (300, 785), (330, 815)]],
    "\u030C": [[(150, 880), (285, 765), (420, 880), (390, 920),
                 (285, 830), (180, 920)]],
    "\u0327": [[(255, -55), (345, -55), (335, -120), (285, -145),
                 (345, -155), (330, -195), (235, -170), (245, -125)]],
    "\u0328": [[(285, -50), (355, -50), (315, -125), (345, -175),
                 (290, -195), (255, -155)]],
}


def add_extended(glyphs: dict[str, list]) -> dict[str, list]:
    extended = {char: contours for char, contours in glyphs.items()}
    for codepoint in range(0x00C0, 0x0180):
        char = chr(codepoint)
        parts = unicodedata.normalize("NFD", char)
        if len(parts) != 2 or parts[0] not in glyphs or parts[1] not in ACCENTS:
            continue
        base = glyphs[parts[0]]
        if parts[0] in "ij" and parts[1] not in ("\u0327", "\u0328"):
            base = [contour for contour in base if min(y for _, y in contour) < 500]
        mark = ACCENTS[parts[1]]
        if parts[1] not in ("\u0327", "\u0328"):
            base_top = max(y for contour in base for _, y in contour)
            mark_bottom = min(y for contour in mark for _, y in contour)
            mark = shifted(mark, dy=base_top + 30 - mark_bottom)
        extended[char] = base + mark
    # These modern signs are convenience glyphs, not historical 938 claims.
    extended["\\"] = [[(ADVANCE - x, y) for x, y in contour]
                       for contour in glyphs["/"]]
    extended["–"] = [rectangle(90, 270, 510, 310)]
    extended["—"] = [rectangle(20, 270, 580, 310)]
    extended["…"] = (shifted(glyphs["."], dx=-195) + glyphs["."]
                       + shifted(glyphs["."], dx=195))
    extended["‘"] = glyphs["`"]
    extended["’"] = glyphs["'"]
    extended["“"] = shifted(glyphs["`"], dx=-75) + shifted(glyphs["`"], dx=75)
    extended["”"] = glyphs['"']
    return extended


def to_glyph(contours: list, glyph_set: dict | None = None):
    pen = TTGlyphPen(glyph_set)
    for points in contours:
        if len(points) < 3:
            continue
        pen.moveTo(points[0])
        for point in points[1:]:
            pen.lineTo(point)
        pen.closePath()
    return pen.glyph()


def write_font(filename: str, family: str, glyphs: dict[str, list],
               description: str) -> list[str]:
    chars = sorted(glyphs, key=ord)
    names = {char: f"uni{ord(char):04X}" for char in chars}
    order = [".notdef", "space"] + [names[char] for char in chars]
    notdef = [rectangle(80, 0, 520, 700),
              [(160, 90), (440, 90), (440, 610), (160, 610)][::-1]]
    outlines = {".notdef": to_glyph(notdef), "space": to_glyph([])}
    outlines.update({names[char]: to_glyph(glyphs[char]) for char in chars})
    builder = FontBuilder(1000, isTTF=True)
    builder.setupGlyphOrder(order)
    builder.setupCharacterMap({ord(char): names[char] for char in chars} | {32: "space"})
    builder.setupGlyf(outlines)
    builder.setupHorizontalMetrics({name: (ADVANCE, 0) for name in order})
    builder.setupHorizontalHeader(ascent=850, descent=-250, lineGap=0)
    builder.setupNameTable({
        "familyName": family,
        "styleName": "Regular",
        "fullName": f"{family} Regular",
        "psName": filename.replace("-", "") + "Regular",
        "uniqueFontIdentifier": f"{family} 0.1.0",
        "version": "Version 0.1.0",
        "description": description,
    })
    builder.setupOS2(
        sTypoAscender=850, sTypoDescender=-250, sTypoLineGap=0,
        usWinAscent=950, usWinDescent=250, sxHeight=430, sCapHeight=735,
        fsType=0,
    )
    builder.setupPost(isFixedPitch=1)
    builder.setupMaxp()
    font = builder.font
    # These timestamps describe the generated file, not the historical proof.
    # Keep them fixed so the same scans produce byte-identical fonts.
    font["head"].created = 2082844800
    font["head"].modified = 2082844800
    font.recalcTimestamp = False
    ttf = HERE / f"{filename}.ttf"
    woff2 = HERE / f"{filename}.woff2"
    font.save(ttf)
    font.flavor = "woff2"
    font.save(woff2)
    return [ttf.name, woff2.name]


def write_specimen(core_filename: str, output_name: str) -> str:
    image = Image.new("RGB", (1800, 980), "#f4efe3")
    draw = ImageDraw.Draw(image)
    core = ImageFont.truetype(HERE / core_filename, 58)
    companion = ImageFont.truetype(HERE / "CTSS-Correspondence-Extended.ttf", 58)
    lines = [
        ("ABCDEFGHIJKLMNOPQRSTUVWXYZ", core),
        ("abcdefghijklmnopqrstuvwxyz", core),
        ("1234567890 =◇;:%'\"*()_+-&", core),
        ("¢ @ ! ± $ # , . ? /", core),
        ("MEN ARE ALL ALIKE.", core),
        ("IN WHAT WAY", core),
        ("Café naïve — déjà vu…", companion),
    ]
    for index, (line, face) in enumerate(lines):
        draw.text((70, 65 + index * 125), line, font=face, fill="#27251f")
    image.save(HERE / output_name)
    return output_name


def main() -> None:
    layout = load_proof(19)
    proof = load_proof(31)
    layout_signs = trace_layout(layout)
    impressions = trace_alphanumerics(proof) | trace_symbols(proof)
    impressions.update({char: layout_signs[char] for char in "¢±◇"})
    archive = {char: impressions[char] for char in CORE}
    core, evidence = consensus_glyphs(layout, proof)
    for char in CORE:
        if not core.get(char):
            raise ValueError(f"Missing core outline: {char!r}")
    extended = add_extended(impressions | core)
    files = []
    files += write_font(
        "CTSS-Correspondence-938", "CTSS Correspondence 938", core,
        "Source-anchored reconstruction from historical 938 impressions; not an IBM font.",
    )
    files += write_font(
        "CTSS-Correspondence-938-Impression", "CTSS Correspondence 938 Impression", archive,
        "One scanned impression per 938 character, retained for comparison.",
    )
    files += write_font(
        "CTSS-Correspondence-Extended", "CTSS Correspondence Extended", extended,
        "Consensus 938 core with convenience characters absent from the element.",
    )
    files.append(write_specimen("CTSS-Correspondence-938.ttf", "specimen.png"))
    files.append(write_specimen(
        "CTSS-Correspondence-938-Impression.ttf", "specimen-impression.png"
    ))
    manifest = {
        "source": str(SOURCE.relative_to(HERE.parent)),
        "source_sha256": SOURCE_SHA256,
        "source_pages": {"938_layout": 19, "ctss_graphics": 31},
        "positions": "".join(LAYOUT_ROWS),
        "core_characters": CORE,
        "core_positions": 88,
        "core_glyphs": len(CORE),
        "core_constructed": "",
        "reconstruction": "source gaps preserved for symbols; clear-proof anchor for two-strike symbols; registered consensus for letters, digits, and multi-strike symbols; uncertain separation of the single ± strike; no element damage inferred",
        "sample_sources": evidence,
        "sample_impressions": sum(map(len, evidence.values())),
        "single_sample_characters": "".join(char for char in CORE if len(evidence[char]) == 1),
        "extended_characters": "".join(sorted(extended, key=ord)),
        "advance_width_units": ADVANCE,
        "units_per_em": 1000,
        "outputs": {name: sha256(HERE / name) for name in files},
    }
    (HERE / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"Built {len(core)} core and {len(extended)} extended glyphs")
    print(f"Single-source characters: {manifest['single_sample_characters']!r}")
    for name in files:
        print(name)


if __name__ == "__main__":
    main()
