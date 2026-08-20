import importlib.util
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from PIL import Image


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "aep-collector"
    / "xbot_aep_collector"
    / "core.py"
)
SPEC = importlib.util.spec_from_file_location("xbot_aep_collector_core", MODULE_PATH)
CORE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CORE
SPEC.loader.exec_module(CORE)

PACKAGE_ROOT = Path(__file__).resolve().parents[1] / "aep-collector"
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))
from xbot_aep_collector import preview as PREVIEW


class SafeFilenameTests(unittest.TestCase):
    def test_replaces_windows_invalid_characters(self):
        self.assertEqual(CORE.safe_filename('包装:人物/信息条?'), "包装_人物_信息条_")

    def test_avoids_windows_reserved_names(self):
        self.assertEqual(CORE.safe_filename("CON"), "_CON")

    def test_uses_fallback_for_blank_name(self):
        self.assertEqual(CORE.safe_filename("   "), "未命名")


class CompositionInfoTests(unittest.TestCase):
    def test_marks_referenced_composition_as_precomp(self):
        item = CORE.CompositionInfo(
            id=2,
            name="内部合成",
            width=1920,
            height=1080,
            duration=5,
            frame_rate=25,
            display_start_frame=0,
            parent_ids=(1,),
            parent_names=("主合成",),
            child_ids=(),
            child_names=(),
        )
        self.assertEqual(item.role, "预合成")

    def test_marks_unreferenced_composition_without_guessing_main_status(self):
        item = CORE.CompositionInfo(
            id=1,
            name="候选合成",
            width=1920,
            height=1080,
            duration=5,
            frame_rate=25,
            display_start_frame=0,
            parent_ids=(),
            parent_names=(),
            child_ids=(),
            child_names=(),
        )
        self.assertEqual(item.role, "顶层 / 未被引用")


class CollectionArchiveTests(unittest.TestCase):
    def test_output_directory_skips_existing_sibling_zip(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "项目_合成_收集.zip").write_bytes(b"existing")

            result = CORE._next_output_directory(root, "项目", "合成")

            self.assertEqual(result.name, "项目_合成_收集_2")

    def test_archive_wraps_collection_and_contains_required_files(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            collection = root / "项目_合成_收集"
            assets = collection / "素材" / "Images"
            assets.mkdir(parents=True)
            output_project = collection / "项目_合成.aep"
            manifest = collection / "manifest.json"
            output_project.write_bytes(b"aep")
            manifest.write_text('{"source_file":"项目_合成_收集.zip"}', encoding="utf-8")
            (assets / "bg.png").write_bytes(b"png")
            zip_file = root / "项目_合成_收集.zip"

            zip_bytes = CORE._write_collection_archive(
                collection,
                zip_file,
                output_project,
                manifest,
            )

            self.assertEqual(zip_bytes, zip_file.stat().st_size)
            with zipfile.ZipFile(zip_file, "r") as archive:
                self.assertIsNone(archive.testzip())
                self.assertEqual(
                    set(archive.namelist()),
                    {
                        "项目_合成_收集/manifest.json",
                        "项目_合成_收集/项目_合成.aep",
                        "项目_合成_收集/素材/Images/bg.png",
                    },
                )

    def test_attaches_preview_metadata_and_refreshes_archive(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            collection = root / "项目_合成_收集"
            collection.mkdir()
            output_project = collection / "项目_合成.aep"
            manifest = collection / "manifest.json"
            output_project.write_bytes(b"aep")
            manifest.write_text('{"source_file":"项目_合成_收集.zip"}', encoding="utf-8")
            zip_file = root / "项目_合成_收集.zip"
            CORE._write_collection_archive(collection, zip_file, output_project, manifest)
            preview_file = root / "项目_合成_收集.png"
            preview_file.write_bytes(b"png")
            result = CORE.CollectionResult(
                source_project="source.aep",
                composition_id=1,
                composition_name="合成",
                output_directory=str(collection),
                output_project=str(output_project),
                manifest_file=str(manifest),
                zip_file=str(zip_file),
                zip_bytes=zip_file.stat().st_size,
                composition_count=1,
                copied_file_count=0,
                copied_bytes=0,
                missing_files=(),
                warnings=(),
                preview_file=None,
                preview_time=None,
                preview_frame=None,
                preview_error=None,
            )

            updated = CORE.attach_collection_preview(result, preview_file, 2.0, 50)

            self.assertEqual(updated.preview_file, str(preview_file))
            self.assertEqual(updated.preview_time, 2.0)
            payload = json.loads(manifest.read_text(encoding="utf-8"))
            self.assertEqual(payload["preview_file"], preview_file.name)
            self.assertEqual(payload["preview"]["frame"], 50)
            with zipfile.ZipFile(zip_file, "r") as archive:
                archived_manifest = json.loads(
                    archive.read("项目_合成_收集/manifest.json").decode("utf-8")
                )
            self.assertEqual(archived_manifest["preview_file"], preview_file.name)


class PreviewFrameTests(unittest.TestCase):
    def test_defaults_to_second_two(self):
        selection = PREVIEW.select_preview_frame(5, 25)
        self.assertEqual(selection.time, 2.0)
        self.assertEqual(selection.frame_index, 50)

    def test_short_composition_uses_last_valid_frame(self):
        selection = PREVIEW.select_preview_frame(1, 25)
        self.assertEqual(selection.frame_index, 24)
        self.assertAlmostEqual(selection.time, 0.96)

    def test_preserves_ae_display_start_frame(self):
        selection = PREVIEW.select_preview_frame(5, 25, 2, display_start_frame=100)
        self.assertEqual(selection.frame_number, 150)

    def test_tiff_conversion_preserves_alpha(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            tiff = Path(temp_dir) / "preview.tif"
            Image.new("RGBA", (2, 1), (120, 60, 30, 128)).save(
                tiff,
                format="TIFF",
                compression="raw",
            )

            converted = PREVIEW._open_rendered_tiff(tiff)

            self.assertEqual(converted.mode, "RGBA")
            self.assertEqual(converted.getchannel("A").getextrema(), (128, 128))


if __name__ == "__main__":
    unittest.main()
