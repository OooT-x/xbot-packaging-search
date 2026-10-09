"""Reproducible Eagle bundle from a Git ref, or an explicitly marked local review snapshot."""
import argparse
import hashlib
import json
import re
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = {"manifest.json", "index.html", "logo.png", "README.md",
            "js/window-controls.js", "js/workbench.js", "js/v5-runtime.js", "lib/ingest-bridge.js", "lib/eagle-api.js"}

def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args])

def build(worker, expected_worker_hash, output, ref="HEAD", worktree=False):
    worker = Path(worker)
    binary = worker.read_bytes()
    digest = hashlib.sha256(binary).hexdigest()
    if digest != expected_worker_hash.lower() or not binary.startswith(b"MZ"):
        raise ValueError("Worker hash mismatch or invalid Windows executable")
    commit = git("rev-parse", "--verify", ref + "^{commit}").decode().strip()
    names = git("ls-tree", "-r", "--name-only", commit, "--", "eagle-plugin").decode("utf-8").splitlines()
    files = {}
    for name in names:
        relative = name.removeprefix("eagle-plugin/")
        allowed = relative in REQUIRED or re.fullmatch(r"(js|lib)/[a-z0-9-]+\.js", relative)
        if not allowed:
            raise ValueError(f"Unreviewed plugin file: {relative}")
        files[relative] = (ROOT / name).read_bytes() if worktree else git("show", f"{commit}:{name}")
    if not REQUIRED.issubset(files):
        raise ValueError("Bundle missing required production files")
    manifest = json.loads(files["manifest.json"].decode("utf-8-sig"))
    version = manifest["version"]
    if manifest["id"] != "LB5UL2P0Q9FFF" or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Invalid plugin id or stable version")
    files["workers/XbotAepWorker.exe"] = binary
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    bundle = output / f"xbot-eagle-plugin-v{version}.eagleplugin"
    if bundle.exists():
        raise FileExistsError(f"Refusing to overwrite existing bundle: {bundle}")
    temporary = bundle.with_suffix(".building")
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in sorted(files.items()):
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                archive.writestr(info, data, compresslevel=9)
        with zipfile.ZipFile(temporary) as archive:
            if archive.testzip() is not None or set(archive.namelist()) != set(files):
                raise ValueError("Bundle CRC or inventory mismatch")
            for name, data in files.items():
                if archive.read(name) != data:
                    raise ValueError(f"Bundle content mismatch: {name}")
        temporary.rename(bundle)
    finally:
        temporary.unlink(missing_ok=True)
    package_hash = hashlib.sha256(bundle.read_bytes()).hexdigest()
    record = {"version": version, "source_commit": commit, "worktree_review_only": worktree,
              "sha256": package_hash, "bytes": bundle.stat().st_size, "worker_sha256": digest,
              "files": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}}
    bundle.with_suffix(".sha256").write_text(f"{package_hash}  {bundle.name}\n", encoding="utf-8")
    bundle.with_suffix(".json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    return bundle, record

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", required=True, type=Path)
    parser.add_argument("--worker-sha256", required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    parser.add_argument("--ref", default="HEAD")
    parser.add_argument("--worktree", action="store_true", help="Local review only; never use for a public release")
    args = parser.parse_args()
    bundle, record = build(args.worker, args.worker_sha256, args.output, args.ref, args.worktree)
    print(json.dumps({"bundle": str(bundle), **record}, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
