"""Generate update.json from a verified stable bundle; never advertise review snapshots."""
import argparse
import hashlib
import json
import re
import zipfile
from datetime import datetime
from pathlib import Path

BASE = "https://github.com/OooT-x/xbot-packaging-search/releases"

def create_manifest(record_path, notes_path, published_at, output):
    record = json.loads(Path(record_path).read_text(encoding="utf-8-sig"))
    version = record.get("version", "")
    if not re.fullmatch(r"\d+\.\d+\.\d+", version) or record.get("worktree_review_only") is not False:
        raise ValueError("Only a verified stable Git-ref bundle can generate a public manifest")
    parsed = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Publication date must include a timezone")
    name = f"xbot-eagle-plugin-v{version}.eagleplugin"
    bundle = Path(record_path).parent / name
    data = bundle.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != record.get("sha256") or len(data) != record.get("bytes"):
        raise ValueError("Bundle size or SHA-256 differs from its build record")
    with zipfile.ZipFile(bundle) as archive:
        if archive.testzip() is not None:
            raise ValueError("Bundle CRC check failed")
        manifest = json.loads(archive.read("manifest.json").decode("utf-8-sig"))
        if manifest.get("id") != "LB5UL2P0Q9FFF" or manifest.get("version") != version:
            raise ValueError("Bundle plugin identity or version mismatch")
        if set(archive.namelist()) != set(record["files"]):
            raise ValueError("Bundle file inventory mismatch")
        for filename, expected in record["files"].items():
            if hashlib.sha256(archive.read(filename)).hexdigest() != expected:
                raise ValueError("Bundle file digest mismatch")
    result = {"schemaVersion": 1, "pluginId": "LB5UL2P0Q9FFF", "channel": "stable",
              "version": version, "title": f"Eagle 插件 v{version}",
              "notes": Path(notes_path).read_text(encoding="utf-8-sig")[:12000],
              "publishedAt": published_at, "releaseUrl": BASE + f"/tag/eagle-plugin-v{version}",
              "asset": {"name": name, "url": BASE + f"/download/eagle-plugin-v{version}/{name}",
                        "size": len(data), "sha256": digest}}
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    return result

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record", required=True, type=Path)
    parser.add_argument("--notes", required=True, type=Path)
    parser.add_argument("--published-at", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    result = create_manifest(args.record, args.notes, args.published_at, args.output)
    print(json.dumps({"output": str(args.output), "version": result["version"], "sha256": result["asset"]["sha256"]}))
