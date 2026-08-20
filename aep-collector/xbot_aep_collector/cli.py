from __future__ import annotations

import argparse
import json
import sys

from .core import CollectorError, collect_many, inspect_project


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="离线查看并按合成收集 AEP 工程")
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser("inspect", help="列出工程内全部合成")
    inspect_parser.add_argument("aep")

    collect_parser = subparsers.add_parser("collect", help="按合成 ID 收集工程")
    collect_parser.add_argument("aep")
    collect_parser.add_argument("--comp-id", type=int, action="append", required=True)
    collect_parser.add_argument("--output", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "inspect":
            result = inspect_project(args.aep).to_dict()
        else:
            result = [item.to_dict() for item in collect_many(args.aep, args.comp_id, args.output)]
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except CollectorError as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
