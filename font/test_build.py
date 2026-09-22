"""Regression checks for the source-anchored 938 font build."""

import json
import unittest

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont

from build import (
    ADVANCE, CORE, HERE, LAYOUT_ROWS, combine_samples, reconstruct_glyph,
    isolated_symbols, load_proof, normalized_sample, sha256,
    vertically_registered,
)


class FontBuildTests(unittest.TestCase):
    def test_element_has_88_positions_and_86_distinct_characters(self):
        positions = "".join(LAYOUT_ROWS)
        self.assertEqual(len(positions), 88)
        self.assertEqual(len(CORE), 86)
        self.assertEqual(positions.count(","), 2)
        self.assertEqual(positions.count("."), 2)
        self.assertEqual(set(CORE), set(positions))

    def test_core_cmap_and_fixed_pitch(self):
        for filename in (
            "CTSS-Correspondence-938.ttf",
            "CTSS-Correspondence-938-Impression.ttf",
        ):
            with self.subTest(filename=filename):
                font = TTFont(HERE / filename)
                cmap = font.getBestCmap()
                self.assertEqual(set(cmap), {32, *(ord(char) for char in CORE)})
                for char in CORE:
                    name = cmap[ord(char)]
                    self.assertEqual(font["hmtx"][name][0], ADVANCE)
                    self.assertGreater(font["glyf"][name].numberOfContours, 0, char)
                for unsupported in "[]<>\\":
                    self.assertNotIn(ord(unsupported), cmap)

    def test_consensus_repairs_a_single_dropout_not_a_spur(self):
        full = np.zeros((80, 40), dtype=np.uint8)
        full[20:61, 17:23] = 1
        damaged = full.copy()
        damaged[37:40, 17:23] = 0
        damaged[10:12, 5:7] = 1
        combined = combine_samples([full, damaged])
        self.assertTrue(np.all(combined[37:40, 17:23]))
        self.assertFalse(np.any(combined[10:12, 5:7]))

    def test_two_strikes_do_not_fill_a_clear_proof_counter(self):
        clear = np.zeros((80, 40), dtype=np.uint8)
        clear[33:39, 9:31] = 1
        clear[42:47, 9:31] = 1
        over_inked = clear.copy()
        over_inked[39:42, 9:31] = 1
        result = reconstruct_glyph("=", [over_inked, clear], clear)
        np.testing.assert_array_equal(result, clear)

    def test_number_sign_has_two_stems_between_its_bars(self):
        proof = load_proof(31)
        source = next(
            normalized_sample(mask, top, baseline, 30, preserve_gaps=True)
            for char, mask, _, top, baseline, _ in isolated_symbols(proof)
            if char == "#"
        )
        restored = reconstruct_glyph("#", [source, source], source)

        def runs(row):
            positions = np.flatnonzero(restored[row])
            return 1 + int(np.count_nonzero(np.diff(positions) > 1))

        self.assertEqual([runs(row) for row in (26, 33, 37, 39, 45)],
                         [2, 1, 2, 1, 2])

    def test_rendered_symbols_keep_their_separate_marks_and_counters(self):
        font = ImageFont.truetype(HERE / "CTSS-Correspondence-938.ttf", 400)

        def topology(char):
            image = Image.new("L", (600, 600), 255)
            ImageDraw.Draw(image).text((100, 0), char, font=font, fill=0)
            ink = (np.asarray(image) < 128).astype(np.uint8)
            ys, xs = np.nonzero(ink)
            ink = ink[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
            components = cv2.connectedComponentsWithStats(ink, connectivity=8)[0] - 1
            background = np.pad(1 - ink, 1, constant_values=1)
            count, _, stats, _ = cv2.connectedComponentsWithStats(
                background, connectivity=4
            )
            holes = sum(
                1 for x, y, width, height, _ in stats[1:count]
                if x > 0 and y > 0
                and x + width < background.shape[1]
                and y + height < background.shape[0]
            )
            return components, holes

        self.assertEqual(topology("="), (2, 0))
        self.assertEqual(topology("!"), (2, 0))
        self.assertEqual(topology("#"), (1, 2))
        self.assertEqual(topology("%"), (3, 2))
        self.assertEqual(topology("±"), (2, 0))

    def test_confirmed_broken_letters_still_use_both_strikes(self):
        complete = np.zeros((80, 40), dtype=np.uint8)
        complete[20:61, 15:20] = 1
        broken = complete.copy()
        broken[36:40, 15:20] = 0
        result = reconstruct_glyph("C", [complete, broken], broken)
        self.assertTrue(np.all(result[36:40, 15:20]))

    def test_consensus_keeps_the_proof_vertical_registration(self):
        consensus = [[(0, -10), (20, -10), (20, 30), (0, 30)]]
        anchor = [[(0, 0), (20, 0), (20, 40), (0, 40)]]
        registered = vertically_registered(consensus, anchor)
        ys = [y for contour in registered for _, y in contour]
        self.assertEqual((min(ys), max(ys)), (0, 40))

    def test_round_cap_and_stem_share_an_optical_center(self):
        font = TTFont(HERE / "CTSS-Correspondence-938.ttf")
        cmap = font.getBestCmap()

        def center(char):
            glyph = font["glyf"][cmap[ord(char)]]
            glyph.recalcBounds(font["glyf"])
            return (glyph.yMin + glyph.yMax) / 2

        self.assertLessEqual(abs(center("C") - center("I")), 25)

    def test_manifest_matches_generated_assets(self):
        manifest = json.loads((HERE / "manifest.json").read_text())
        self.assertEqual(manifest["source_pages"], {
            "938_layout": 19, "ctss_graphics": 31,
        })
        self.assertEqual(manifest["positions"], "".join(LAYOUT_ROWS))
        self.assertEqual(manifest["core_characters"], CORE)
        self.assertEqual(manifest["core_glyphs"], len(CORE))
        self.assertEqual(set(manifest["sample_sources"]), set(CORE))
        self.assertEqual(
            manifest["sample_impressions"],
            sum(map(len, manifest["sample_sources"].values())),
        )
        self.assertEqual(set(manifest["single_sample_characters"]), set("◇_¢@±"))
        self.assertGreaterEqual(
            sum(len(sources) >= 2 for sources in manifest["sample_sources"].values()),
            81,
        )
        self.assertNotEqual(
            manifest["outputs"]["CTSS-Correspondence-938.ttf"],
            manifest["outputs"]["CTSS-Correspondence-938-Impression.ttf"],
        )
        for filename, expected in manifest["outputs"].items():
            self.assertEqual(sha256(HERE / filename), expected, filename)


if __name__ == "__main__":
    unittest.main()
