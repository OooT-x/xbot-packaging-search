from __future__ import annotations

import argparse
import json
import sys

from .core import (
    CollectorError,
    collect_many,
    collect_precompositions,
    direct_precompositions,
    inspect_project,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="离线查看并按合成收集 AEP 工程")
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser("inspect", help="列出工程内全部合成")
    inspect_parser.add_argument("aep")

    precomp_parser = subparsers.add_parser(
        "list-precomps",
        aliases=["precomps"],
        help="列出指定合成直属的预合成",
    )
    precomp_parser.add_argument("aep")
    precomp_parser.add_argument("--comp-id", type=int, required=True)

    collect_parser = subparsers.add_parser("collect", help="按合成 ID 收集工程")
    collect_parser.add_argument("aep")
    collect_parser.add_argument("--comp-id", type=int, action="append", required=True)
    collect_parser.add_argument("--output", required=True)

    collect_precomp_parser = subparsers.add_parser(
        "collect-precomps",
        help="将指定合成的直属预合成分别收集并打包",
    )
    collect_precomp_parser.add_argument("aep")
    collect_precomp_parser.add_argument("--comp-id", type=int, required=True)
    collect_precomp_parser.add_argument("--output", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "inspect":
            result = inspect_project(args.aep).to_dict()
        elif args.command in {"list-precomps", "precomps"}:
            project = inspect_project(args.aep)
            target = next(
                (item for item in project.compositions if item.id == args.comp_id),
                None,
            )
            if target is None:
                raise CollectorError(f"找不到合成 ID：{args.comp_id}")
            children = direct_precompositions(project, target)
            result = {
                "composition": target.to_dict(),
                "precomposition_count": len(children),
                "precompositions": [item.to_dict() for item in children],
            }
        elif args.command == "collect-precomps":
            result = [
                item.to_dict()
                for item in collect_precompositions(
                    args.aep,
                    args.comp_id,
                    args.output,
                )
            ]
        else:
            result = [item.to_dict() for item in collect_many(args.aep, args.comp_id, args.output)]
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except CollectorError as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
