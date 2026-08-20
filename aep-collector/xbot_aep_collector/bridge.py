from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from .preview import PreviewError, select_preview_frame


BRIDGE_DIRECTORY_ENV = "XBOT_AE_PREVIEW_BRIDGE_DIR"
BRIDGE_VERSION = "1.0"
BRIDGE_STATUS_MAX_AGE_SECONDS = 5.0
BRIDGE_RENDER_TIMEOUT_SECONDS = 30.0


class BridgeUnavailable(PreviewError):
    """The optional live AE preview bridge cannot serve this request."""


@dataclass(frozen=True)
class BridgeRenderResult:
    output_file: str
    time: float
    frame_index: int
    frame_number: int
    renderer: str
    log: str


def bridge_directory() -> Path:
    configured = os.environ.get(BRIDGE_DIRECTORY_ENV, "").strip().strip('"')
    if configured:
        return Path(configured).expanduser().resolve()
    appdata = os.environ.get("APPDATA")
    if appdata:
        return (Path(appdata) / "XbotAepPreviewBridge").resolve()
    return (Path.home() / ".xbot-aep-preview-bridge").resolve()


def _normalize_path(value: str | Path) -> str:
    return str(Path(value).expanduser().resolve()).replace("\\", "/").casefold()


def _read_json(path: Path) -> dict | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, TypeError):
        return None
    return payload if isinstance(payload, dict) else None


def bridge_status(aep_path: str | Path | None = None) -> tuple[bool, str]:
    status_path = bridge_directory() / "status.json"
    payload = _read_json(status_path)
    if not payload:
        return False, "AE 快速预览桥接未运行"
    if payload.get("running") is not True:
        return False, "AE 快速预览桥接已停止"
    try:
        heartbeat_ms = float(payload.get("heartbeat_ms", 0))
    except (TypeError, ValueError):
        heartbeat_ms = 0
    age_seconds = time.time() - heartbeat_ms / 1000.0
    if age_seconds < -5 or age_seconds > BRIDGE_STATUS_MAX_AGE_SECONDS:
        return False, "AE 快速预览桥接已离线"
    if str(payload.get("bridge_version", "")) != BRIDGE_VERSION:
        return False, "AE 快速预览桥接版本不匹配"
    if not payload.get("project_path"):
        return False, "AE 快速预览桥接中没有打开工程"
    if aep_path is not None and _normalize_path(payload["project_path"]) != _normalize_path(aep_path):
        return False, "AE 中打开的不是当前 AEP"
    return True, "AE 快速预览桥接已连接"


def _is_complete_png(path: Path) -> bool:
    try:
        size = path.stat().st_size
        if size < 20:
            return False
        with path.open("rb") as stream:
            if stream.read(8) != b"\x89PNG\r\n\x1a\n":
                return False
            stream.seek(-12, os.SEEK_END)
            return stream.read(12) == b"\x00\x00\x00\x00IEND\xaeB`\x82"
    except OSError:
        return False


def render_bridge_preview(
    aep_path: str | Path,
    comp_id: int,
    comp_name: str,
    duration: float,
    frame_rate: float,
    requested_time: float,
    output_file: str | Path,
    display_start_frame: int = 0,
    timeout_seconds: float = BRIDGE_RENDER_TIMEOUT_SECONDS,
) -> BridgeRenderResult:
    available, message = bridge_status(aep_path)
    if not available:
        raise BridgeUnavailable(message)

    target = Path(output_file).expanduser().resolve()
    if target.suffix.lower() != ".png":
        raise PreviewError("预览输出必须是 PNG 文件。")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.unlink(missing_ok=True)
    selection = select_preview_frame(
        duration,
        frame_rate,
        requested_time=requested_time,
        display_start_frame=display_start_frame,
    )

    root = bridge_directory()
    root.mkdir(parents=True, exist_ok=True)
    request_id = uuid.uuid4().hex
    request = {
        "bridge_version": BRIDGE_VERSION,
        "request_id": request_id,
        "project_path": str(Path(aep_path).expanduser().resolve()),
        "composition_id": int(comp_id),
        "composition_name": str(comp_name),
        "time_seconds": float(selection.time),
        "output_file": str(target),
        "created_at_ms": int(time.time() * 1000),
    }
    request_path = root / "request.json"
    partial_request = root / f"request-{request_id}.partial"
    try:
        partial_request.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
        partial_request.replace(request_path)
    except OSError as exc:
        partial_request.unlink(missing_ok=True)
        raise BridgeUnavailable(f"无法写入 AE 快速预览请求：{exc}") from exc

    response_path = root / "response.json"
    deadline = time.monotonic() + max(1.0, float(timeout_seconds))
    accepted = False
    response_message = ""
    while time.monotonic() < deadline:
        response = _read_json(response_path)
        if response and response.get("request_id") == request_id:
            if not response.get("ok"):
                raise BridgeUnavailable(str(response.get("error") or "AE 快速预览桥接拒绝了请求"))
            accepted = True
            response_message = str(response.get("message") or "AE 已接收快速预览请求")
        if accepted and _is_complete_png(target):
            return BridgeRenderResult(
                output_file=str(target),
                time=selection.time,
                frame_index=selection.frame_index,
                frame_number=selection.frame_number,
                renderer="ae-saveFrameToPng-bridge",
                log=response_message,
            )
        time.sleep(0.05)

    target.unlink(missing_ok=True)
    raise BridgeUnavailable(
        f"AE 快速预览超过 {timeout_seconds:g} 秒，已回退到高质量后台渲染。"
    )
