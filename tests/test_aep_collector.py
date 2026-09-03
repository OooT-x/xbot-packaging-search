import ast
import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

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
from xbot_aep_collector import bridge as BRIDGE


class SafeFilenameTests(unittest.TestCase):
    def test_replaces_windows_invalid_characters(self):
        self.assertEqual(CORE.safe_filename('包装:人物/信息条?'), "包装_人物_信息条_")

    def test_avoids_windows_reserved_names(self):
        self.assertEqual(CORE.safe_filename("CON"), "_CON")

    def test_uses_fallback_for_blank_name(self):
        self.assertEqual(CORE.safe_filename("   "), "未命名")


class CompositionInfoTests(unittest.TestCase):
    def test_inspection_records_parent_layer_timing_for_precomposition(self):
        class CompItem:
            def __init__(self, comp_id, name, duration):
                self.id = comp_id
                self.name = name
                self.width = 1920
                self.height = 1080
                self.duration = duration
                self.frame_rate = 25
                self.display_start_frame = 0
                self.used_in = []
                self.composition_layers = []

        class Layer:
            def __init__(self, layer_id, source):
                self.id = layer_id
                self.name = source.name
                self.source = source
                self.start_time = 3.0
                self.in_point = 4.0
                self.out_point = 9.0

        parent = CompItem(1, "包装", 12.0)
        child = CompItem(2, "视频框", 5.0)
        layer = Layer(21, child)
        parent.composition_layers = [layer]
        child.used_in = [parent]

        class FakeProject:
            compositions = [parent, child]

            def __iter__(self):
                return iter(self.compositions)

        fake_app = SimpleNamespace(
            project=FakeProject(),
            version="25.6",
        )
        fake_py_aep = SimpleNamespace(parse=lambda _path: fake_app)

        with tempfile.TemporaryDirectory() as temp_dir:
            aep = Path(temp_dir) / "project.aep"
            aep.write_bytes(b"aep")
            with mock.patch.object(CORE, "_load_py_aep", return_value=fake_py_aep):
                project = CORE.inspect_project(aep)

        inspected_child = next(item for item in project.compositions if item.id == 2)
        self.assertEqual(inspected_child.child_ids, ())
        self.assertEqual(len(inspected_child.parent_layer_usages), 1)
        usage = inspected_child.parent_layer_usages[0]
        self.assertEqual(usage.parent_id, 1)
        self.assertEqual(usage.in_point, 4.0)
        self.assertEqual(usage.out_point, 9.0)

    def test_video_frame_parent_preview_starts_two_seconds_after_layer_in_point(self):
        usage = CORE.CompositionLayerUsage(
            parent_id=1,
            parent_name="包装",
            layer_id=21,
            layer_name="视频框",
            start_time=3.0,
            in_point=4.0,
            out_point=12.0,
        )
        video_frame = CORE.CompositionInfo(
            id=2,
            name="视频框",
            width=1280,
            height=720,
            duration=5,
            frame_rate=25,
            display_start_frame=0,
            parent_ids=(1,),
            parent_names=("包装",),
            child_ids=(),
            child_names=(),
            parent_layer_usages=(usage,),
        )
        packaging = CORE.CompositionInfo(
            id=1,
            name="包装",
            width=1920,
            height=1080,
            duration=20,
            frame_rate=25,
            display_start_frame=0,
            parent_ids=(),
            parent_names=(),
            child_ids=(2,),
            child_names=("视频框",),
        )
        project = CORE.ProjectInfo(
            path="project.aep",
            ae_version="25.6",
            item_count=2,
            compositions=(packaging, video_frame),
        )

        self.assertEqual(
            CORE.preview_source_layer_usage(project, video_frame, packaging),
            usage,
        )
        self.assertEqual(CORE.preview_time_for_source(project, video_frame, packaging), 6.0)

    def test_video_frame_parent_preview_clamps_to_last_visible_parent_frame(self):
        usage = CORE.CompositionLayerUsage(
            parent_id=1,
            parent_name="包装",
            layer_id=21,
            layer_name="视频框",
            start_time=3.0,
            in_point=4.0,
            out_point=5.0,
        )
        video_frame = CORE.CompositionInfo(
            id=2,
            name="视频框",
            width=1280,
            height=720,
            duration=5,
            frame_rate=25,
            display_start_frame=0,
            parent_ids=(1,),
            parent_names=("包装",),
            child_ids=(),
            child_names=(),
            parent_layer_usages=(usage,),
        )
        packaging = CORE.CompositionInfo(
            id=1,
            name="包装",
            width=1920,
            height=1080,
            duration=20,
            frame_rate=25,
            display_start_frame=0,
            parent_ids=(),
            parent_names=(),
            child_ids=(2,),
            child_names=("视频框",),
        )
        project = CORE.ProjectInfo(
            path="project.aep",
            ae_version="25.6",
            item_count=2,
            compositions=(packaging, video_frame),
        )

        self.assertAlmostEqual(
            CORE.preview_time_for_source(project, video_frame, packaging),
            4.96,
        )

    def test_lists_unique_direct_precompositions_in_layer_order(self):
        target = CORE.CompositionInfo(
            id=1,
            name="包装",
            width=1920,
            height=1080,
            duration=5,
            frame_rate=25,
            display_start_frame=0,
            parent_ids=(),
            parent_names=(),
            child_ids=(3, 2, 3, 999, 1),
            child_names=("背景", "标注", "背景", "已删除", "包装"),
        )
        background = CORE.CompositionInfo(
            id=3,
            name="背景",
            width=1920,
            height=1080,
            duration=5,
            frame_rate=25,
            display_start_frame=0,
            parent_ids=(1,),
            parent_names=("包装",),
            child_ids=(),
            child_names=(),
        )
        label = CORE.CompositionInfo(
            id=2,
            name="标注",
            width=500,
            height=300,
            duration=5,
            frame_rate=25,
            display_start_frame=0,
            parent_ids=(1,),
            parent_names=("包装",),
            child_ids=(),
            child_names=(),
        )
        project = CORE.ProjectInfo(
            path="project.aep",
            ae_version="25.6",
            item_count=3,
            compositions=(target, background, label),
        )

        result = CORE.direct_precompositions(project, target)

        self.assertEqual([item.id for item in result], [3, 2])
        self.assertEqual([item.name for item in result], ["背景", "标注"])

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

    def test_video_frame_prefers_unique_parent_packaging_composition_with_background(self):
        video_frame = CORE.CompositionInfo(
            id=2,
            name="视频框",
            width=1280,
            height=720,
            duration=5,
            frame_rate=25,
            display_start_frame=0,
            parent_ids=(1,),
            parent_names=("包装",),
            child_ids=(),
            child_names=(),
        )
        packaging = CORE.CompositionInfo(
            id=1,
            name="包装",
            width=1920,
            height=1080,
            duration=10,
            frame_rate=25,
            display_start_frame=0,
            parent_ids=(),
            parent_names=(),
            child_ids=(2, 3),
            child_names=("视频框", "背景"),
        )
        background = CORE.CompositionInfo(
            id=3,
            name="背景",
            width=1920,
            height=1080,
            duration=10,
            frame_rate=25,
            display_start_frame=0,
            parent_ids=(1,),
            parent_names=("包装",),
            child_ids=(),
            child_names=(),
        )
        project = CORE.ProjectInfo(
            path="project.aep",
            ae_version="25.6",
            item_count=3,
            compositions=(packaging, video_frame, background),
        )

        recommendation = CORE.recommend_preview_source(project, video_frame)

        self.assertEqual(recommendation.source_id, packaging.id)
        self.assertEqual(recommendation.relation, "parent-display")

    def test_ambiguous_video_frame_parent_keeps_self_until_user_selects(self):
        video_frame = CORE.CompositionInfo(
            id=3,
            name="横屏视频框",
            width=1280,
            height=720,
            duration=5,
            frame_rate=25,
            display_start_frame=0,
            parent_ids=(1, 2),
            parent_names=("包装 A", "包装 B"),
            child_ids=(),
            child_names=(),
        )
        parents = tuple(
            CORE.CompositionInfo(
                id=item_id,
                name=f"包装 {name}",
                width=1920,
                height=1080,
                duration=10,
                frame_rate=25,
                display_start_frame=0,
                parent_ids=(),
                parent_names=(),
                child_ids=(3,),
                child_names=("横屏视频框",),
            )
            for item_id, name in ((1, "A"), (2, "B"))
        )
        project = CORE.ProjectInfo(
            path="project.aep",
            ae_version="25.6",
            item_count=3,
            compositions=(*parents, video_frame),
        )

        recommendation = CORE.recommend_preview_source(project, video_frame)

        self.assertEqual(recommendation.source_id, video_frame.id)
        self.assertIn("多个", recommendation.reason)


class GuiLayoutTests(unittest.TestCase):
    def test_tk_frame_constructor_padding_is_scalar(self):
        gui_path = PACKAGE_ROOT / "xbot_aep_collector" / "gui.py"
        tree = ast.parse(gui_path.read_text(encoding="utf-8"))
        invalid = []
        for node in ast.walk(tree):
            if not (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "tk"
                and node.func.attr == "Frame"
            ):
                continue
            for keyword in node.keywords:
                if keyword.arg in {"padx", "pady"} and not isinstance(
                    keyword.value, ast.Constant
                ):
                    invalid.append((node.lineno, keyword.arg))

        self.assertEqual(invalid, [])


class PrecompositionCollectionTests(unittest.TestCase):
    def test_collects_each_direct_precomposition_as_an_independent_item(self):
        target = CORE.CompositionInfo(
            id=1,
            name="包装",
            width=1920,
            height=1080,
            duration=5,
            frame_rate=25,
            display_start_frame=0,
            parent_ids=(),
            parent_names=(),
            child_ids=(2, 3),
            child_names=("信息条", "背景"),
        )
        children = tuple(
            CORE.CompositionInfo(
                id=item_id,
                name=name,
                width=1920,
                height=1080,
                duration=5,
                frame_rate=25,
                display_start_frame=0,
                parent_ids=(1,),
                parent_names=("包装",),
                child_ids=(),
                child_names=(),
            )
            for item_id, name in ((2, "信息条"), (3, "背景"))
        )
        project = CORE.ProjectInfo(
            path="project.aep",
            ae_version="25.6",
            item_count=3,
            compositions=(target, *children),
        )

        with mock.patch.object(CORE, "inspect_project", return_value=project), mock.patch.object(
            CORE, "collect_many", return_value=[]
        ) as collect_many:
            result = CORE.collect_precompositions("project.aep", 1, "output")

        self.assertEqual(result, [])
        args = collect_many.call_args.args
        self.assertEqual(tuple(args[1]), (2, 3))
        self.assertEqual(args[0], "project.aep")
        self.assertEqual(args[2], "output")


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

            updated = CORE.attach_collection_preview(
                result,
                preview_file,
                2.0,
                50,
                preview_source_id=9,
                preview_source_name="包装展示",
                preview_source_relation="parent-display",
                preview_source_layer=CORE.CompositionLayerUsage(
                    parent_id=9,
                    parent_name="包装展示",
                    layer_id=21,
                    layer_name="视频框",
                    start_time=0.5,
                    in_point=1.0,
                    out_point=8.0,
                ),
            )

            self.assertEqual(updated.preview_file, str(preview_file))
            self.assertEqual(updated.preview_time, 2.0)
            payload = json.loads(manifest.read_text(encoding="utf-8"))
            self.assertEqual(payload["preview_file"], preview_file.name)
            self.assertEqual(payload["preview"]["frame"], 50)
            self.assertEqual(payload["preview"]["source_composition"]["id"], 9)
            self.assertEqual(payload["preview"]["source_layer"]["in_point"], 1.0)
            self.assertEqual(payload["preview"]["source_layer"]["sample_offset_seconds"], 1.0)
            self.assertEqual(updated.preview_source_name, "包装展示")
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

    def test_aerender_prefers_direct_png_template(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            project = root / "project.aep"
            aerender = root / "aerender.exe"
            target = root / "preview.png"
            project.write_bytes(b"aep")
            aerender.write_bytes(b"exe")

            def fake_run(command, timeout_seconds):
                self.assertEqual(timeout_seconds, PREVIEW.DEFAULT_RENDER_TIMEOUT_SECONDS)
                template = command[command.index("-OMtemplate") + 1]
                self.assertEqual(template, "Xbot PNG with Alpha")
                output_pattern = command[command.index("-output") + 1]
                rendered = Path(output_pattern.replace("[#####]", "00050"))
                Image.new("RGBA", (3, 2), (20, 40, 60, 128)).save(rendered, "PNG")
                return 0, "direct png"

            with mock.patch.object(PREVIEW, "_run_aerender", side_effect=fake_run) as run:
                result = PREVIEW.render_preview(
                    project,
                    "包装展示",
                    5,
                    25,
                    2,
                    target,
                    aerender_path=aerender,
                )

            self.assertEqual(run.call_count, 1)
            self.assertEqual(result.template_name, "Xbot PNG with Alpha")
            self.assertEqual(result.renderer, "aerender-png")
            self.assertTrue(PREVIEW._is_complete_png(target))
            with Image.open(target) as image:
                self.assertEqual(image.mode, "RGBA")
                self.assertEqual(image.getchannel("A").getextrema(), (128, 128))

    def test_aerender_falls_back_to_tiff_when_png_template_is_missing(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            project = root / "project.aep"
            aerender = root / "aerender.exe"
            target = root / "preview.png"
            project.write_bytes(b"aep")
            aerender.write_bytes(b"exe")

            def fake_run(command, _timeout_seconds):
                template = command[command.index("-OMtemplate") + 1]
                if template == "Xbot PNG with Alpha":
                    return 1, "template does not exist"
                output_pattern = command[command.index("-output") + 1]
                rendered = Path(output_pattern.replace("[#####]", "00050"))
                Image.new("RGBA", (3, 2), (80, 60, 40, 192)).save(
                    rendered,
                    "TIFF",
                    compression="raw",
                )
                return 0, "tiff fallback"

            with mock.patch.object(PREVIEW, "_run_aerender", side_effect=fake_run) as run:
                result = PREVIEW.render_preview(
                    project,
                    "包装展示",
                    5,
                    25,
                    2,
                    target,
                    aerender_path=aerender,
                )

            self.assertEqual(run.call_count, 2)
            self.assertEqual(result.renderer, "aerender-tiff-png")
            self.assertIn("已回退 TIFF 中转", result.log)
            self.assertTrue(PREVIEW._is_complete_png(target))


class PreviewBridgeTests(unittest.TestCase):
    def test_live_bridge_renders_complete_png(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            project = root / "project.aep"
            project.write_bytes(b"aep")
            status = {
                "bridge_version": BRIDGE.BRIDGE_VERSION,
                "running": True,
                "heartbeat_ms": int(time.time() * 1000),
                "project_path": str(project),
            }
            (root / "status.json").write_text(json.dumps(status), encoding="utf-8")

            def simulate_after_effects():
                request_path = root / "request.json"
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline and not request_path.is_file():
                    time.sleep(0.01)
                request = json.loads(request_path.read_text(encoding="utf-8"))
                Image.new("RGB", (4, 3), (20, 40, 60)).save(request["output_file"], "PNG")
                response = {
                    "request_id": request["request_id"],
                    "ok": True,
                    "message": "accepted",
                }
                (root / "response.json").write_text(json.dumps(response), encoding="utf-8")

            worker = threading.Thread(target=simulate_after_effects, daemon=True)
            worker.start()
            with mock.patch.dict(
                os.environ,
                {BRIDGE.BRIDGE_DIRECTORY_ENV: str(root)},
            ):
                result = BRIDGE.render_bridge_preview(
                    project,
                    1,
                    "包装",
                    5,
                    25,
                    2,
                    root / "preview.png",
                    timeout_seconds=2,
                )
            worker.join(timeout=2)

            self.assertEqual(result.renderer, "ae-saveFrameToPng-bridge")
            self.assertTrue(BRIDGE._is_complete_png(Path(result.output_file)))

    def test_bridge_rejects_different_open_project(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            status = {
                "bridge_version": BRIDGE.BRIDGE_VERSION,
                "running": True,
                "heartbeat_ms": int(time.time() * 1000),
                "project_path": str(root / "other.aep"),
            }
            (root / "status.json").write_text(json.dumps(status), encoding="utf-8")
            with mock.patch.dict(os.environ, {BRIDGE.BRIDGE_DIRECTORY_ENV: str(root)}):
                available, reason = BRIDGE.bridge_status(root / "project.aep")

            self.assertFalse(available)
            self.assertIn("不是当前", reason)


if __name__ == "__main__":
    unittest.main()
