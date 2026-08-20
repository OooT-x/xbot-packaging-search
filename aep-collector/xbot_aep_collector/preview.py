from __future__ import annotations

import math
import locale
import os
import re
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
AERENDER_PATH_ENV = "XBOT_AERENDER_PATH"


class PreviewError(CollectorError):
    """A user-facing preview rendering error."""


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


def _template_candidates() -> tuple[str, ...]:
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
        rendered, template_name, log = _render_tiff(
            aerender,
            project,
            comp_name,
            selection.frame_number,
            temp_root,
            _template_candidates(),
            timeout_seconds,
        )
        partial = target.with_name(f".{target.name}.partial")
        partial.unlink(missing_ok=True)
        try:
            with _open_rendered_tiff(rendered) as image:
                image.save(partial, format="PNG", optimize=True)
            if not partial.is_file() or partial.stat().st_size <= 0:
                raise PreviewError("TIFF 转 PNG 后未生成有效文件。")
            partial.replace(target)
        finally:
            partial.unlink(missing_ok=True)

    return PreviewRenderResult(
        output_file=str(target),
        time=selection.time,
        frame_index=selection.frame_index,
        frame_number=selection.frame_number,
        aerender_path=str(aerender),
        template_name=template_name,
        log=log,
    )
