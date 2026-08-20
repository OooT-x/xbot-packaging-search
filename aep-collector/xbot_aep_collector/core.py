from __future__ import annotations

import hashlib
import json
import re
import shutil
import uuid
import zipfile
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


IMAGE_EXTENSIONS = {
    ".ai",
    ".bmp",
    ".dpx",
    ".exr",
    ".gif",
    ".hdr",
    ".jpeg",
    ".jpg",
    ".pdf",
    ".png",
    ".psb",
    ".psd",
    ".tga",
    ".tif",
    ".tiff",
    ".webp",
}
VIDEO_EXTENSIONS = {
    ".avi",
    ".m2ts",
    ".m4v",
    ".mkv",
    ".mov",
    ".mp4",
    ".mpeg",
    ".mpg",
    ".mts",
    ".mxf",
    ".webm",
    ".wmv",
}
AUDIO_EXTENSIONS = {
    ".aac",
    ".aif",
    ".aiff",
    ".flac",
    ".m4a",
    ".mp3",
    ".ogg",
    ".wav",
    ".wma",
}
INVALID_WINDOWS_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}
VIDEO_FRAME_NAME = re.compile(r"(?:视频框|横屏框|竖屏框|画面框|视频画框)")
DISPLAY_COMPOSITION_NAME = re.compile(r"(?:包装|展示|主合成|总合成|成片|预览)")
BACKGROUND_COMPOSITION_NAME = re.compile(r"(?:背景|底图|底板)")


class CollectorError(RuntimeError):
    """A user-facing collection error."""


@dataclass(frozen=True)
class CompositionInfo:
    id: int
    name: str
    width: int
    height: int
    duration: float
    frame_rate: float
    display_start_frame: int
    parent_ids: tuple[int, ...]
    parent_names: tuple[str, ...]
    child_ids: tuple[int, ...]
    child_names: tuple[str, ...]

    @property
    def role(self) -> str:
        return "预合成" if self.parent_ids else "顶层 / 未被引用"

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["role"] = self.role
        return result


@dataclass(frozen=True)
class ProjectInfo:
    path: str
    ae_version: str
    item_count: int
    compositions: tuple[CompositionInfo, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "ae_version": self.ae_version,
            "item_count": self.item_count,
            "composition_count": len(self.compositions),
            "compositions": [item.to_dict() for item in self.compositions],
        }


@dataclass(frozen=True)
class PreviewSourceRecommendation:
    source_id: int
    source_name: str
    relation: str
    reason: str


@dataclass(frozen=True)
class CollectionResult:
    source_project: str
    composition_id: int
    composition_name: str
    output_directory: str
    output_project: str
    manifest_file: str
    zip_file: str
    zip_bytes: int
    composition_count: int
    copied_file_count: int
    copied_bytes: int
    missing_files: tuple[str, ...]
    warnings: tuple[str, ...]
    preview_file: str | None
    preview_time: float | None
    preview_frame: int | None
    preview_error: str | None
    preview_source_id: int | None = None
    preview_source_name: str | None = None
    preview_renderer: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _load_py_aep():
    try:
        import py_aep  # type: ignore
    except ImportError as exc:
        raise CollectorError(
            "缺少 py-aep。请运行 aep-collector/run.ps1，或执行 "
            "python -m pip install -r aep-collector/requirements.txt。"
        ) from exc
    return py_aep


def safe_filename(value: str, fallback: str = "未命名") -> str:
    cleaned = INVALID_WINDOWS_NAME.sub("_", str(value)).strip().rstrip(". ")
    cleaned = re.sub(r"\s+", " ", cleaned)
    if not cleaned:
        cleaned = fallback
    if cleaned.upper() in WINDOWS_RESERVED_NAMES:
        cleaned = f"_{cleaned}"
    return cleaned[:120]


def _composition_children(comp: Any) -> list[Any]:
    children: list[Any] = []
    seen: set[int] = set()
    for layer in getattr(comp, "composition_layers", ()):
        source = getattr(layer, "source", None)
        source_id = getattr(source, "id", None)
        if source_id is not None and source_id not in seen:
            seen.add(source_id)
            children.append(source)
    return children


def inspect_project(aep_path: str | Path) -> ProjectInfo:
    path = Path(aep_path).expanduser().resolve()
    if not path.is_file() or path.suffix.lower() != ".aep":
        raise CollectorError(f"请选择有效的 AEP 工程：{path}")

    py_aep = _load_py_aep()
    try:
        app = py_aep.parse(str(path))
    except Exception as exc:
        raise CollectorError(f"无法解析 AEP：{exc}") from exc

    project = app.project
    compositions = list(project.compositions)
    rows: list[CompositionInfo] = []
    for comp in compositions:
        parents = list(getattr(comp, "used_in", ()))
        children = _composition_children(comp)
        rows.append(
            CompositionInfo(
                id=int(comp.id),
                name=str(comp.name),
                width=int(comp.width),
                height=int(comp.height),
                duration=float(comp.duration),
                frame_rate=float(comp.frame_rate),
                display_start_frame=int(getattr(comp, "display_start_frame", 0)),
                parent_ids=tuple(int(item.id) for item in parents),
                parent_names=tuple(str(item.name) for item in parents),
                child_ids=tuple(int(item.id) for item in children),
                child_names=tuple(str(item.name) for item in children),
            )
        )

    rows.sort(key=lambda item: (bool(item.parent_ids), item.name.casefold(), item.id))
    return ProjectInfo(
        path=str(path),
        ae_version=str(app.version),
        item_count=len(list(project)),
        compositions=tuple(rows),
    )


def preview_source_candidates(
    project: ProjectInfo,
    target: CompositionInfo,
) -> tuple[CompositionInfo, ...]:
    by_id = {item.id: item for item in project.compositions}
    parents = [by_id[item_id] for item_id in target.parent_ids if item_id in by_id]
    parents.sort(key=lambda item: (item.name.casefold(), item.id))
    return (target, *parents)


def _preview_parent_score(parent: CompositionInfo, target: CompositionInfo) -> int:
    display_named = bool(DISPLAY_COMPOSITION_NAME.search(parent.name))
    has_background = any(BACKGROUND_COMPOSITION_NAME.search(name) for name in parent.child_names)
    if not display_named and not has_background:
        return 0
    score = 4 if display_named else 0
    score += 3 if has_background else 0
    score += 1 if any(item_id != target.id for item_id in parent.child_ids) else 0
    score += 1 if parent.width >= target.width and parent.height >= target.height else 0
    return score


def recommend_preview_source(
    project: ProjectInfo,
    target: CompositionInfo,
) -> PreviewSourceRecommendation:
    if not VIDEO_FRAME_NAME.search(target.name):
        return PreviewSourceRecommendation(
            source_id=target.id,
            source_name=target.name,
            relation="self",
            reason="普通合成默认使用自身画面",
        )

    parents = preview_source_candidates(project, target)[1:]
    scored = [(item, _preview_parent_score(item, target)) for item in parents]
    positive = [(item, score) for item, score in scored if score > 0]
    if positive:
        best_score = max(score for _item, score in positive)
        best = [item for item, score in positive if score == best_score]
        if len(best) == 1:
            source = best[0]
            return PreviewSourceRecommendation(
                source_id=source.id,
                source_name=source.name,
                relation="parent-display",
                reason="视频框默认使用包含背景的上层包装展示合成",
            )

    reason = "未找到唯一的上层包装展示合成，暂用视频框自身"
    if len(positive) > 1:
        reason = "存在多个同等上层包装展示合成，等待用户选择"
    return PreviewSourceRecommendation(
        source_id=target.id,
        source_name=target.name,
        relation="self",
        reason=reason,
    )


def _walk_dependencies(root_comp: Any) -> tuple[dict[int, Any], dict[int, Any]]:
    comps: dict[int, Any] = {}
    footage: dict[int, Any] = {}

    def visit(comp: Any) -> None:
        comp_id = int(comp.id)
        if comp_id in comps:
            return
        comps[comp_id] = comp
        for layer in getattr(comp, "layers", ()):
            source = getattr(layer, "source", None)
            source_id = getattr(source, "id", None)
            if source_id is None:
                continue
            if source.__class__.__name__ == "CompItem":
                visit(source)
            elif source.__class__.__name__ == "FootageItem":
                footage[int(source_id)] = source

    visit(root_comp)
    return comps, footage


def _category_for(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in IMAGE_EXTENSIONS:
        return "Images"
    if suffix in VIDEO_EXTENSIONS:
        return "Video"
    if suffix in AUDIO_EXTENSIONS:
        return "Audio"
    return "Other"


def _unique_destination(folder: Path, source: Path, item_id: int) -> Path:
    target = folder / safe_filename(source.name)
    if not target.exists():
        return target
    try:
        if target.samefile(source):
            return target
    except OSError:
        pass
    suffix = source.suffix
    return folder / f"{safe_filename(source.stem)}__{item_id}{suffix}"


def _sequence_files(footage: Any, source_path: Path) -> list[Path]:
    names = list(getattr(getattr(footage, "main_source", None), "file_names", ()) or ())
    if len(names) <= 1:
        return [source_path]
    result: list[Path] = []
    for name in names:
        candidate = Path(str(name))
        if not candidate.is_absolute():
            candidate = source_path.parent / candidate
        result.append(candidate)
    return result


def _copy_and_relink_footage(
    footage: Any,
    assets_root: Path,
    missing: list[str],
    warnings: list[str],
) -> tuple[int, int]:
    raw_file = getattr(footage, "file", None)
    if not raw_file:
        return 0, 0

    source_path = Path(str(raw_file))
    if not source_path.exists():
        missing.append(str(source_path))
        return 0, 0

    category_folder = assets_root / _category_for(source_path)
    category_folder.mkdir(parents=True, exist_ok=True)
    original_name = str(getattr(footage, "name", source_path.name))

    if source_path.is_dir():
        destination = _unique_destination(category_folder, source_path, int(footage.id))
        shutil.copytree(source_path, destination)
        copied_files = [item for item in destination.rglob("*") if item.is_file()]
        warnings.append(f"目录素材“{original_name}”已复制，但未自动重链接，请打开收集工程复核。")
        return len(copied_files), sum(item.stat().st_size for item in copied_files)

    sequence = _sequence_files(footage, source_path)
    destination_folder = category_folder
    if len(sequence) > 1:
        destination_folder = category_folder / f"{safe_filename(source_path.stem)}__seq_{footage.id}"
        destination_folder.mkdir(parents=True, exist_ok=True)

    copied: list[tuple[Path, Path]] = []
    for frame in sequence:
        if not frame.is_file():
            missing.append(str(frame))
            continue
        destination = _unique_destination(destination_folder, frame, int(footage.id))
        shutil.copy2(frame, destination)
        copied.append((frame, destination))

    if not copied:
        return 0, 0

    original_resolved = source_path.resolve()
    representative = next(
        (dest for src, dest in copied if src.resolve() == original_resolved),
        copied[0][1],
    )
    try:
        if len(sequence) > 1:
            footage.replace_with_sequence(str(representative), force_alphabetical=False)
        else:
            footage.replace(str(representative))
        footage.name = original_name
    except Exception as exc:
        warnings.append(f"素材“{original_name}”已复制但重链接失败：{exc}")

    return len(copied), sum(dest.stat().st_size for _, dest in copied)


def _reduce_project(project: Any, root_comp: Any) -> None:
    """Reduce through py-aep and repair its stale active-item reference.

    py-aep 0.10.2 mirrors AE's Reduce Project dependency traversal, but it does
    not update the loose ``fcid`` chunk when the previously active composition
    is removed. Leaving that stale ID produces an AEP that cannot be parsed
    again. Point both the model and the binary chunk at the kept root comp.
    """

    project.reduce_project([root_comp])
    try:
        from py_aep.binary.utils import find_by_type  # type: ignore

        active_item_chunk = find_by_type(chunks=project._rifx.chunks, chunk_type="fcid")
        active_item_chunk.value = int(root_comp.id)
    except Exception as exc:
        raise CollectorError(f"无法修复收集工程的活动合成引用：{exc}") from exc
    project._active_item = root_comp


def _next_output_directory(output_root: Path, project_name: str, comp_name: str) -> Path:
    base = safe_filename(f"{project_name}_{comp_name}_收集")
    candidate = output_root / base
    counter = 2
    while candidate.exists() or _zip_path_for_directory(candidate).exists():
        candidate = output_root / f"{base}_{counter}"
        counter += 1
    return candidate


def _zip_path_for_directory(directory: Path) -> Path:
    return directory.parent / f"{directory.name}.zip"


def _write_collection_archive(
    collection_directory: Path,
    zip_file: Path,
    output_project: Path,
    manifest_file: Path,
) -> int:
    partial_zip = zip_file.parent / f".{zip_file.name}.{uuid.uuid4().hex}.partial"
    archive_root = Path(collection_directory.name)
    try:
        with zipfile.ZipFile(
            partial_zip,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=6,
        ) as archive:
            for path in sorted(collection_directory.rglob("*")):
                if path.is_file():
                    relative_path = archive_root / path.relative_to(collection_directory)
                    archive.write(path, arcname=relative_path.as_posix())

        required_entries = {
            (archive_root / output_project.name).as_posix(),
            (archive_root / manifest_file.name).as_posix(),
        }
        with zipfile.ZipFile(partial_zip, "r") as archive:
            corrupt_entry = archive.testzip()
            if corrupt_entry:
                raise CollectorError(f"ZIP 完整性校验失败：{corrupt_entry}")
            missing_entries = required_entries.difference(archive.namelist())
            if missing_entries:
                names = "、".join(sorted(missing_entries))
                raise CollectorError(f"ZIP 交付文件缺失：{names}")

        partial_zip.replace(zip_file)
        return zip_file.stat().st_size
    finally:
        partial_zip.unlink(missing_ok=True)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def collect_composition(
    aep_path: str | Path,
    composition_id: int,
    output_root: str | Path,
) -> CollectionResult:
    source_path = Path(aep_path).expanduser().resolve()
    target_root = Path(output_root).expanduser().resolve()
    if not source_path.is_file() or source_path.suffix.lower() != ".aep":
        raise CollectorError(f"请选择有效的 AEP 工程：{source_path}")
    target_root.mkdir(parents=True, exist_ok=True)

    py_aep = _load_py_aep()
    try:
        app = py_aep.parse(str(source_path))
    except Exception as exc:
        raise CollectorError(f"无法解析 AEP：{exc}") from exc

    project = app.project
    root_comp = next(
        (comp for comp in project.compositions if int(comp.id) == int(composition_id)),
        None,
    )
    if root_comp is None:
        raise CollectorError(f"找不到合成 ID：{composition_id}")

    final_directory = _next_output_directory(target_root, source_path.stem, str(root_comp.name))
    zip_file = _zip_path_for_directory(final_directory)
    final_directory.mkdir(parents=True, exist_ok=False)
    incomplete_marker = final_directory / ".xbot-collection-incomplete"
    incomplete_marker.write_text(uuid.uuid4().hex, encoding="ascii")

    missing: list[str] = []
    warnings: list[str] = []
    copied_file_count = 0
    copied_bytes = 0
    try:
        comps, footage = _walk_dependencies(root_comp)
        assets_root = final_directory / "素材"
        for item in footage.values():
            count, size = _copy_and_relink_footage(item, assets_root, missing, warnings)
            copied_file_count += count
            copied_bytes += size

        _reduce_project(project, root_comp)
        output_project = final_directory / safe_filename(f"{source_path.stem}_{root_comp.name}.aep")
        project.save(str(output_project))

        try:
            validation_app = py_aep.parse(str(output_project))
            validation_ids = {int(comp.id) for comp in validation_app.project.compositions}
        except Exception as exc:
            raise CollectorError(f"收集工程保存后自检失败：{exc}") from exc
        if int(root_comp.id) not in validation_ids:
            raise CollectorError("收集工程保存后自检失败：目标合成不存在。")

        manifest = {
            "manifest_version": "1.0",
            "manifest_type": "xbot-collection",
            "collector": "X.bot AEP Collector",
            "collector_mode": "offline-py-aep",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "source_project": str(source_path),
            "source_project_sha256": _sha256(source_path),
            "ae_version": str(app.version),
            "composition": {
                "id": int(root_comp.id),
                "name": str(root_comp.name),
                "width": int(root_comp.width),
                "height": int(root_comp.height),
                "duration": float(root_comp.duration),
                "frame_rate": float(root_comp.frame_rate),
            },
            "included_compositions": [
                {"id": int(comp.id), "name": str(comp.name)} for comp in comps.values()
            ],
            "copied_file_count": copied_file_count,
            "copied_bytes": copied_bytes,
            "missing_files": missing,
            "warnings": warnings,
            "dependency_status": "阻止入库" if missing else ("警告" if warnings else "完整"),
            "output_project": output_project.name,
            "collection_directory": final_directory.name,
            "source_file": zip_file.name,
        }
        manifest_file = final_directory / "manifest.json"
        manifest_file.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        incomplete_marker.unlink()
        zip_bytes = _write_collection_archive(
            final_directory,
            zip_file,
            output_project,
            manifest_file,
        )
        return CollectionResult(
            source_project=str(source_path),
            composition_id=int(root_comp.id),
            composition_name=str(root_comp.name),
            output_directory=str(final_directory),
            output_project=str(final_directory / output_project.name),
            manifest_file=str(final_directory / manifest_file.name),
            zip_file=str(zip_file),
            zip_bytes=zip_bytes,
            composition_count=len(comps),
            copied_file_count=copied_file_count,
            copied_bytes=copied_bytes,
            missing_files=tuple(missing),
            warnings=tuple(warnings),
            preview_file=None,
            preview_time=None,
            preview_frame=None,
            preview_error=None,
        )
    except Exception:
        shutil.rmtree(final_directory, ignore_errors=True)
        zip_file.unlink(missing_ok=True)
        raise


def collect_many(
    aep_path: str | Path,
    composition_ids: Iterable[int],
    output_root: str | Path,
) -> list[CollectionResult]:
    return [collect_composition(aep_path, comp_id, output_root) for comp_id in composition_ids]


def attach_collection_preview(
    result: CollectionResult,
    preview_file: str | Path,
    preview_time: float,
    preview_frame: int,
    preview_source_id: int | None = None,
    preview_source_name: str | None = None,
    preview_source_relation: str = "self",
    preview_renderer: str = "aerender",
) -> CollectionResult:
    preview_path = Path(preview_file).expanduser().resolve()
    manifest_path = Path(result.manifest_file).resolve()
    collection_directory = Path(result.output_directory).resolve()
    output_project = Path(result.output_project).resolve()
    zip_file = Path(result.zip_file).resolve()
    if not preview_path.is_file() or preview_path.suffix.lower() != ".png":
        raise CollectorError(f"预览 PNG 不存在：{preview_path}")
    if preview_path.parent != zip_file.parent:
        raise CollectorError("预览 PNG 必须与对应 ZIP 位于同一目录。")

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise CollectorError(f"无法读取收集 manifest：{exc}") from exc
    manifest["preview_file"] = preview_path.name
    manifest["preview"] = {
        "time_seconds": float(preview_time),
        "frame": int(preview_frame),
        "renderer": str(preview_renderer),
        "source_composition": {
            "id": int(preview_source_id if preview_source_id is not None else result.composition_id),
            "name": str(preview_source_name or result.composition_name),
            "relation": str(preview_source_relation),
        },
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    zip_bytes = _write_collection_archive(
        collection_directory,
        zip_file,
        output_project,
        manifest_path,
    )
    return replace(
        result,
        zip_bytes=zip_bytes,
        preview_file=str(preview_path),
        preview_time=float(preview_time),
        preview_frame=int(preview_frame),
        preview_error=None,
        preview_source_id=int(
            preview_source_id if preview_source_id is not None else result.composition_id
        ),
        preview_source_name=str(preview_source_name or result.composition_name),
        preview_renderer=str(preview_renderer),
    )


def mark_collection_preview_error(result: CollectionResult, error: Exception | str) -> CollectionResult:
    message = str(error).strip() or "未知预览错误"
    return replace(result, preview_error=message)
