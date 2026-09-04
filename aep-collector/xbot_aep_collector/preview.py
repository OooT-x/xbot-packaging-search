from __future__ import annotations

import math
import locale
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from PIL import Image

from .core import CollectorError


DEFAULT_PREVIEW_SECONDS = 2.0
DEFAULT_RENDER_TIMEOUT_SECONDS = 180
PREVIEW_TEMPLATE_ENV = "XBOT_AERENDER_STILL_TEMPLATE"
PNG_PREVIEW_TEMPLATE_ENV = "XBOT_AERENDER_PNG_TEMPLATE"
DEFAULT_PNG_PREVIEW_TEMPLATE = "Xbot PNG with Alpha"
AERENDER_PATH_ENV = "XBOT_AERENDER_PATH"


class PreviewError(CollectorError):
    """A user-facing preview rendering error."""


class DirectPngUnavailable(PreviewError):
    """The configured direct PNG output module cannot render this frame."""


@dataclass(frozen=True)
class FrameSelection:
    requested_time: float
    time: float
    frame_index: int
    frame_number: int
    last_frame_index: int


@dataclass(frozen=True)
class PreviewRenderResult:
    output_file: str
    time: float
    frame_index: int
    frame_number: int
    aerender_path: str
    template_name: str
    log: str
    renderer: str = "aerender"


def select_preview_frame(
    duration: float,
    frame_rate: float,
    requested_time: float = DEFAULT_PREVIEW_SECONDS,
    display_start_frame: int = 0,
) -> FrameSelection:
    if not math.isfinite(duration) or duration <= 0:
        raise PreviewError("合成时长无效，无法选择预览帧。")
    if not math.isfinite(frame_rate) or frame_rate <= 0:
        raise PreviewError("合成帧率无效，无法选择预览帧。")
    if not math.isfinite(requested_time):
        raise PreviewError("预览时间必须是有效数字。")

    frame_count = max(1, int(math.ceil(duration * frame_rate - 1e-9)))
    last_frame_index = frame_count - 1
    clamped_time = max(0.0, min(float(requested_time), last_frame_index / frame_rate))
    frame_index = min(
        last_frame_index,
        max(0, int(math.floor(clamped_time * frame_rate + 0.5))),
    )
    frame_time = frame_index / frame_rate
    return FrameSelection(
        requested_time=float(requested_time),
        time=frame_time,
        frame_index=frame_index,
        frame_number=int(display_start_frame) + frame_index,
        last_frame_index=last_frame_index,
    )


def default_preview_time(duration: float, frame_rate: float) -> float:
    return select_preview_frame(duration, frame_rate).time


def _version_key(path: Path) -> tuple[int, ...]:
    numbers = re.findall(r"\d+", str(path.parent.parent.name))
    return tuple(int(value) for value in numbers) or (0,)


def find_aerender() -> Path:
    configured = os.environ.get(AERENDER_PATH_ENV, "").strip().strip('"')
    if configured:
        candidate = Path(configured).expanduser()
        if candidate.is_file():
            return candidate.resolve()
        raise PreviewError(f"{AERENDER_PATH_ENV} 指向的文件不存在：{candidate}")

    candidates: list[Path] = []
    for root_value in (os.environ.get("ProgramFiles"), os.environ.get("ProgramW6432")):
        if not root_value:
            continue
        adobe_root = Path(root_value) / "Adobe"
        if not adobe_root.is_dir():
            continue
        candidates.extend(adobe_root.glob("Adobe After Effects */Support Files/aerender.exe"))
    candidates = sorted({path.resolve() for path in candidates if path.is_file()}, key=_version_key, reverse=True)
    if not candidates:
        raise PreviewError(
            "未找到 aerender.exe。请安装 After Effects，或设置 "
            f"{AERENDER_PATH_ENV} 指定路径。"
        )
    return candidates[0]


def _load_py_aep():
    """Load py-aep through the collector's common dependency gate.

    Keep this small wrapper in this module so the name-isolation path stays
    directly testable without requiring a real AEP fixture.
    """

    from .core import _load_py_aep as load_py_aep

    return load_py_aep()


def _unique_render_name(existing_names: Iterable[str], composition_id: int) -> str:
    """Return a temporary composition name that cannot collide in AE.

    ``aerender -comp`` selects by name.  The selected composition ID is the
    authoritative identity everywhere else in this project, so an ambiguous
    name must be isolated before invoking aerender.
    """

    used = {str(name).casefold() for name in existing_names}
    base = f"__xbot_preview_comp_{int(composition_id)}__"
    candidate = base
    suffix = 2
    while candidate.casefold() in used:
        candidate = f"{base}{suffix}"
        suffix += 1
    return candidate


def _prepare_render_target(
    project_path: Path,
    comp_name: str,
    composition_id: int | None,
    temp_root: Path,
) -> tuple[Path, str, str]:
    """Return the AEP and name that aerender should use for one composition.

    AEP composition IDs are stable, but aerender accepts only a name.  When
    an input project has duplicate names, save a short-lived project copy with
    only the requested composition renamed to a unique token.  The original
    AEP remains untouched and every layer reference still resolves by ID.
    """

    if composition_id is None:
        return project_path, comp_name, ""

    py_aep = _load_py_aep()
    try:
        app = py_aep.parse(str(project_path))
        compositions = list(app.project.compositions)
    except Exception as exc:
        raise PreviewError(f"无法解析预览工程以定位合成 ID {composition_id}：{exc}") from exc

    target = next(
        (item for item in compositions if int(getattr(item, "id", -1)) == int(composition_id)),
        None,
    )
    if target is None:
        raise PreviewError(f"预览工程中找不到合成 ID：{composition_id}")

    target_name = str(target.name)
    same_name = [
        item
        for item in compositions
        if str(getattr(item, "name", "")).casefold() == target_name.casefold()
    ]
    if len(same_name) <= 1:
        return project_path, target_name, ""

    unique_name = _unique_render_name(
        (str(getattr(item, "name", "")) for item in compositions),
        int(composition_id),
    )
    temporary_project = temp_root / f"render-target-{int(composition_id)}.aep"
    try:
        target.name = unique_name
        app.project.save(str(temporary_project))
    except Exception as exc:
        raise PreviewError(
            f"无法为同名合成“{target_name}”（ID {composition_id}）创建临时渲染工程：{exc}"
        ) from exc
    if not temporary_project.is_file() or temporary_project.stat().st_size <= 0:
        raise PreviewError(
            f"同名合成“{target_name}”（ID {composition_id}）的临时渲染工程未生成。"
        )
    return (
        temporary_project,
        unique_name,
        f"检测到同名合成“{target_name}”，已用临时工程按 ID {composition_id} 定位渲染。",
    )


def _png_template_candidates() -> tuple[str, ...]:
    configured = os.environ.get(PNG_PREVIEW_TEMPLATE_ENV, "").strip()
    values = [configured] if configured else []
    values.append(DEFAULT_PNG_PREVIEW_TEMPLATE)
    return tuple(dict.fromkeys(value for value in values if value))


def _tiff_template_candidates() -> tuple[str, ...]:
    configured = os.environ.get(PREVIEW_TEMPLATE_ENV, "")
    values = [configured] if configured else []
    # AE's Chinese built-in template contains a trailing space. Keep it intact.
    values.extend(
        [
            "带有 Alpha 的 TIFF 序列 ",
            "TIFF Sequence with Alpha",
            "TIFF Sequence with Alpha ",
        ]
    )
    return tuple(dict.fromkeys(value for value in values if value))


def _format_process_output(stdout: str, stderr: str) -> str:
    combined = "\n".join(value.strip() for value in (stdout, stderr) if value.strip())
    return combined[-12000:]


def _terminate_process_tree(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            capture_output=True,
            text=True,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    else:
        process.kill()


def _run_aerender(command: list[str], timeout_seconds: int) -> tuple[int, str]:
    creationflags = 0
    if os.name == "nt":
        creationflags |= getattr(subprocess, "CREATE_NO_WINDOW", 0)
        creationflags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding=locale.getpreferredencoding(False),
        errors="replace",
        creationflags=creationflags,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        _terminate_process_tree(process)
        stdout, stderr = process.communicate()
        log = _format_process_output(stdout, stderr)
        raise PreviewError(
            f"AE 后台渲染超过 {timeout_seconds} 秒，已终止本次预览。"
            + (f"\n\n{log}" if log else "")
        ) from exc
    return int(process.returncode), _format_process_output(stdout, stderr)


def _as_int_tuple(value) -> tuple[int, ...]:
    if isinstance(value, (tuple, list)):
        return tuple(int(item) for item in value)
    return (int(value),)


def _unpremultiply_rgba(data: bytes) -> bytes:
    pixels = bytearray(data)
    for index in range(0, len(pixels), 4):
        alpha = pixels[index + 3]
        if alpha == 0:
            pixels[index] = 0
            pixels[index + 1] = 0
            pixels[index + 2] = 0
        elif alpha < 255:
            pixels[index] = min(255, (pixels[index] * 255 + alpha // 2) // alpha)
            pixels[index + 1] = min(255, (pixels[index + 1] * 255 + alpha // 2) // alpha)
            pixels[index + 2] = min(255, (pixels[index + 2] * 255 + alpha // 2) // alpha)
    return bytes(pixels)


def _open_rendered_tiff(path: Path) -> Image.Image:
    with Image.open(path) as source:
        width, height = source.size
        tags = source.tag_v2
        samples = int(tags.get(277, len(source.getbands())))
        bits = _as_int_tuple(tags.get(258, (8,) * samples))
        compression = int(tags.get(259, 1))
        planar = int(tags.get(284, 1))
        offsets = _as_int_tuple(tags.get(273, ()))
        byte_counts = _as_int_tuple(tags.get(279, ()))
        orientation = int(tags.get(274, 1))
        extra_samples = _as_int_tuple(tags.get(338, (0,)))
        if (
            samples == 4
            and all(value == 8 for value in bits)
            and compression == 1
            and planar == 1
            and orientation == 1
            and offsets
            and len(offsets) == len(byte_counts)
        ):
            with path.open("rb") as stream:
                strips = []
                for offset, byte_count in zip(offsets, byte_counts):
                    stream.seek(offset)
                    strips.append(stream.read(byte_count))
            raw = b"".join(strips)
            expected = width * height * 4
            if len(raw) >= expected:
                # AE's built-in TIFF+Alpha template is premultiplied. PNG stores
                # straight alpha, so restore RGB before saving.
                rgba = raw[:expected]
                if not extra_samples or extra_samples[0] != 2:
                    rgba = _unpremultiply_rgba(rgba)
                return Image.frombytes("RGBA", (width, height), rgba)
        return source.convert("RGBA" if "A" in source.getbands() else "RGB")


def _is_complete_png(path: Path) -> bool:
    try:
        if not path.is_file() or path.stat().st_size < 20:
            return False
        with path.open("rb") as stream:
            if stream.read(8) != b"\x89PNG\r\n\x1a\n":
                return False
            stream.seek(-12, os.SEEK_END)
            return stream.read(12) == b"\x00\x00\x00\x00IEND\xaeB`\x82"
    except OSError:
        return False


def _render_png(
    aerender: Path,
    project: Path,
    comp_name: str,
    frame_number: int,
    temp_root: Path,
    templates: Iterable[str],
    timeout_seconds: int,
) -> tuple[Path, str, str]:
    failures: list[str] = []
    for attempt, template_name in enumerate(templates, start=1):
        attempt_root = temp_root / f"png-attempt-{attempt}"
        attempt_root.mkdir(parents=True, exist_ok=True)
        output_pattern = attempt_root / "preview_[#####].png"
        command = [
            str(aerender),
            "-project",
            str(project),
            "-comp",
            comp_name,
            "-s",
            str(frame_number),
            "-e",
            str(frame_number),
            "-OMtemplate",
            template_name,
            "-output",
            str(output_pattern),
            "-v",
            "ERRORS_AND_PROGRESS",
            "-sound",
            "OFF",
            "-continueOnMissingFootage",
        ]
        exit_code, log = _run_aerender(command, timeout_seconds)
        rendered = [path for path in sorted(attempt_root.glob("preview_*.png")) if _is_complete_png(path)]
        if exit_code == 0 and len(rendered) == 1:
            return rendered[0], template_name, log
        reason = log or f"aerender 退出码 {exit_code}，未生成完整 PNG。"
        failures.append(f"模板“{template_name}”：{reason}")
    raise DirectPngUnavailable("直接 PNG 输出不可用。\n\n" + "\n\n".join(failures))


def _render_tiff(
    aerender: Path,
    project: Path,
    comp_name: str,
    frame_number: int,
    temp_root: Path,
    templates: Iterable[str],
    timeout_seconds: int,
) -> tuple[Path, str, str]:
    failures: list[str] = []
    for attempt, template_name in enumerate(templates, start=1):
        attempt_root = temp_root / f"attempt-{attempt}"
        attempt_root.mkdir(parents=True, exist_ok=True)
        output_pattern = attempt_root / "preview_[#####].tif"
        command = [
            str(aerender),
            "-project",
            str(project),
            "-comp",
            comp_name,
            "-s",
            str(frame_number),
            "-e",
            str(frame_number),
            "-OMtemplate",
            template_name,
            "-output",
            str(output_pattern),
            "-v",
            "ERRORS_AND_PROGRESS",
            "-sound",
            "OFF",
            "-continueOnMissingFootage",
        ]
        exit_code, log = _run_aerender(command, timeout_seconds)
        rendered = sorted(attempt_root.glob("preview_*.tif")) + sorted(attempt_root.glob("preview_*.tiff"))
        if exit_code == 0 and len(rendered) == 1 and rendered[0].stat().st_size > 0:
            return rendered[0], template_name, log
        reason = log or f"aerender 退出码 {exit_code}，未生成单帧文件。"
        failures.append(f"模板“{template_name.rstrip()}”：{reason}")
    raise PreviewError("无法用当前 AE 输出模板生成预览。\n\n" + "\n\n".join(failures))


def render_preview(
    aep_path: str | Path,
    comp_name: str,
    duration: float,
    frame_rate: float,
    requested_time: float,
    output_file: str | Path,
    display_start_frame: int = 0,
    aerender_path: str | Path | None = None,
    timeout_seconds: int = DEFAULT_RENDER_TIMEOUT_SECONDS,
    composition_id: int | None = None,
) -> PreviewRenderResult:
    project = Path(aep_path).expanduser().resolve()
    if not project.is_file() or project.suffix.lower() != ".aep":
        raise PreviewError(f"预览工程不存在：{project}")
    target = Path(output_file).expanduser().resolve()
    if target.suffix.lower() != ".png":
        raise PreviewError("预览输出必须是 PNG 文件。")
    target.parent.mkdir(parents=True, exist_ok=True)

    selection = select_preview_frame(
        duration,
        frame_rate,
        requested_time=requested_time,
        display_start_frame=display_start_frame,
    )
    aerender = Path(aerender_path).expanduser().resolve() if aerender_path else find_aerender()
    if not aerender.is_file():
        raise PreviewError(f"aerender.exe 不存在：{aerender}")

    with tempfile.TemporaryDirectory(prefix="xbot-aep-preview-") as temp_dir:
        temp_root = Path(temp_dir)
        render_project, render_comp_name, identity_note = _prepare_render_target(
            project,
            comp_name,
            composition_id,
            temp_root,
        )
        partial = target.with_name(f".{target.name}.partial")
        partial.unlink(missing_ok=True)
        renderer = "aerender-png"
        try:
            try:
                rendered, template_name, log = _render_png(
                    aerender,
                    render_project,
                    render_comp_name,
                    selection.frame_number,
                    temp_root,
                    _png_template_candidates(),
                    timeout_seconds,
                )
                shutil.copyfile(rendered, partial)
                if not _is_complete_png(partial):
                    raise PreviewError("直接输出的 PNG 文件不完整。")
            except DirectPngUnavailable as direct_error:
                rendered, template_name, fallback_log = _render_tiff(
                    aerender,
                    render_project,
                    render_comp_name,
                    selection.frame_number,
                    temp_root,
                    _tiff_template_candidates(),
                    timeout_seconds,
                )
                with _open_rendered_tiff(rendered) as image:
                    image.save(partial, format="PNG", optimize=True)
                if not _is_complete_png(partial):
                    raise PreviewError("TIFF 转 PNG 后未生成有效文件。")
                renderer = "aerender-tiff-png"
                log = f"{direct_error}\n\n已回退 TIFF 中转。\n{fallback_log}".strip()
            partial.replace(target)
        finally:
            partial.unlink(missing_ok=True)

    if identity_note:
        log = f"{identity_note}\n{log}".strip()

    return PreviewRenderResult(
        output_file=str(target),
        time=selection.time,
        frame_index=selection.frame_index,
        frame_number=selection.frame_number,
        aerender_path=str(aerender),
        template_name=template_name,
        log=log,
        renderer=renderer,
    )
