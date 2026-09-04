from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from xbot_aep_collector.core import (
    CollectorError,
    attach_collection_preview,
    collect_composition,
    inspect_project,
    mark_collection_preview_error,
    preview_source_candidates,
    preview_source_layer_usage,
    preview_time_for_source,
    recommend_preview_source,
)
from xbot_aep_collector.preview import render_preview, select_preview_frame

PROGRESS_PREFIX = "XBOT_PROGRESS "


def emit_progress(payload: dict) -> None:
    print(f"{PROGRESS_PREFIX}{json.dumps(payload, ensure_ascii=True)}", flush=True)


def _composition(project, composition_id: int):
    return next(
        (item for item in project.compositions if item.id == int(composition_id)),
        None,
    )


def _preview_metadata(project, target, requested_time: float | None = None) -> dict:
    by_id = {item.id: item for item in project.compositions}
    recommendation = recommend_preview_source(project, target)
    source = by_id.get(recommendation.source_id, target)
    time_seconds = (
        preview_time_for_source(project, target, source)
        if requested_time is None
        else float(requested_time)
    )
    selection = select_preview_frame(
        source.duration,
        source.frame_rate,
        time_seconds,
        display_start_frame=source.display_start_frame,
    )
    layer = preview_source_layer_usage(project, target, source)
    return {
        "source_id": source.id,
        "source_name": source.name,
        "relation": "self" if source.id == target.id else "parent-display",
        "reason": recommendation.reason,
        "time_seconds": selection.time,
        "frame": selection.frame_number,
        "frame_index": selection.frame_index,
        "source_layer": (
            {
                "parent_id": layer.parent_id,
                "parent_name": layer.parent_name,
                "layer_id": layer.layer_id,
                "layer_name": layer.layer_name,
                "start_time": layer.start_time,
                "in_point": layer.in_point,
                "out_point": layer.out_point,
                "sample_offset_seconds": selection.time - layer.in_point,
            }
            if layer is not None
            else None
        ),
    }


def inspect_payload(aep_path: str) -> dict:
    project = inspect_project(aep_path)
    payload = project.to_dict()
    payload["preview_recommendations"] = {
        str(comp.id): _preview_metadata(project, comp)
        for comp in project.compositions
    }
    payload["direct_precomposition_ids"] = {
        str(comp.id): list(comp.child_ids) for comp in project.compositions
    }
    return payload


def preview_payload(
    aep_path: str,
    composition_id: int,
    output_file: str,
    requested_time: float | None = None,
) -> dict:
    project = inspect_project(aep_path)
    target = _composition(project, composition_id)
    if target is None:
        raise CollectorError(f"找不到合成 ID：{composition_id}")
    metadata = _preview_metadata(project, target, requested_time)
    rendered = render_preview(
        aep_path,
        metadata["source_name"],
        next(item for item in project.compositions if item.id == metadata["source_id"]).duration,
        next(item for item in project.compositions if item.id == metadata["source_id"]).frame_rate,
        metadata["time_seconds"],
        output_file,
        display_start_frame=next(
            item for item in project.compositions if item.id == metadata["source_id"]
        ).display_start_frame,
        composition_id=metadata["source_id"],
    )
    return {
        "composition_id": target.id,
        "composition_name": target.name,
        "preview_file": rendered.output_file,
        "preview_time": rendered.time,
        "preview_frame": rendered.frame_number,
        "preview_renderer": rendered.renderer,
        "preview_source_id": metadata["source_id"],
        "preview_source_name": metadata["source_name"],
        "preview_source_relation": metadata["relation"],
        "preview_source_layer": metadata["source_layer"],
    }


def collect_payload(
    aep_path: str,
    composition_ids: list[int],
    output_root: str,
    preview_times: dict[int, float] | None = None,
    progress=None,
) -> list[dict]:
    project = inspect_project(aep_path)
    by_id = {item.id: item for item in project.compositions}
    preview_times = preview_times or {}
    unique_ids: list[int] = []
    seen_ids: set[int] = set()
    for composition_id in composition_ids:
        normalized_id = int(composition_id)
        if normalized_id in seen_ids:
            continue
        seen_ids.add(normalized_id)
        unique_ids.append(normalized_id)
    results = []
    total = len(unique_ids)
    if progress:
        progress({"command": "collect", "event": "start", "total": total, "completed": 0})
    for index, composition_id in enumerate(unique_ids):
        target = by_id.get(composition_id)
        if target is None:
            raise CollectorError(f"找不到合成 ID：{composition_id}")
        if progress:
            progress({
                "command": "collect",
                "event": "composition",
                "phase": "collect",
                "index": index + 1,
                "total": total,
                "completed": index,
                "composition_id": target.id,
                "composition_name": target.name,
            })
        result = collect_composition(aep_path, target.id, output_root)
        if progress:
            progress({
                "command": "collect",
                "event": "composition",
                "phase": "preview",
                "index": index + 1,
                "total": total,
                "completed": index,
                "composition_id": target.id,
                "composition_name": target.name,
            })
        preview_target = Path(result.zip_file).with_suffix(".png")
        metadata = _preview_metadata(project, target, preview_times.get(target.id))
        source = by_id[metadata["source_id"]]
        try:
            rendered = render_preview(
                aep_path,
                source.name,
                source.duration,
                source.frame_rate,
                metadata["time_seconds"],
                preview_target,
                display_start_frame=source.display_start_frame,
                composition_id=source.id,
            )
            result = attach_collection_preview(
                result,
                preview_target,
                rendered.time,
                rendered.frame_number,
                preview_source_id=source.id,
                preview_source_name=source.name,
                preview_source_relation=metadata["relation"],
                preview_renderer=rendered.renderer,
                preview_source_layer=next(
                    (
                        usage
                        for usage in target.parent_layer_usages
                        if usage.parent_id == source.id
                    ),
                    None,
                ),
            )
        except Exception as exc:
            preview_target.unlink(missing_ok=True)
            result = mark_collection_preview_error(result, exc)
        results.append(result.to_dict())
        if progress:
            progress({
                "command": "collect",
                "event": "composition",
                "phase": "complete",
                "index": index + 1,
                "total": total,
                "completed": index + 1,
                "composition_id": target.id,
                "composition_name": target.name,
                "status": "warning" if result.warnings or result.preview_error else "ready",
            })
    if progress:
        progress({"command": "collect", "event": "done", "total": total, "completed": total})
    return results


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="X.bot Eagle 插件用 AEP Worker")
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser("inspect", help="读取 AEP 合成结构")
    inspect_parser.add_argument("aep")

    preview_parser = subparsers.add_parser("preview", help="生成单个合成的交互预览 PNG")
    preview_parser.add_argument("aep")
    preview_parser.add_argument("--comp-id", type=int, required=True)
    preview_parser.add_argument("--output", required=True)
    preview_parser.add_argument("--time", type=float)

    collect_parser = subparsers.add_parser("collect", help="收集合成并生成 PNG、ZIP、manifest")
    collect_parser.add_argument("aep")
    collect_parser.add_argument("--comp-id", type=int, action="append", required=True)
    collect_parser.add_argument("--output", required=True)
    collect_parser.add_argument(
        "--preview-time",
        action="append",
        default=[],
        metavar="COMP_ID=SECONDS",
        help="覆盖指定合成的代表帧秒数",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "inspect":
            result = inspect_payload(args.aep)
        elif args.command == "preview":
            result = preview_payload(args.aep, args.comp_id, args.output, args.time)
        else:
            preview_times = {}
            for value in args.preview_time:
                try:
                    comp_id, seconds = value.split("=", 1)
                    preview_times[int(comp_id)] = float(seconds)
                except ValueError as exc:
                    raise CollectorError(f"预览时间格式无效：{value}，应为 COMP_ID=SECONDS") from exc
            result = collect_payload(args.aep, args.comp_id, args.output, preview_times, progress=emit_progress)
        # Keep the process protocol ASCII-safe on Windows consoles (some
        # PyInstaller console hosts still expose a GBK stdout encoding).
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc), "error_type": type(exc).__name__}, ensure_ascii=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
