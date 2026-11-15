#!/usr/bin/env python3
"""Capture the original Node suite; never execute package.json's shell command."""
import argparse
import glob
import json
import os
import shlex
import subprocess
import tempfile
from pathlib import Path


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError) as error:
        raise ValueError(f"Cannot read JSON: {path}") from error


def expand_entries(source):
    command = read_json(source / "package.json")["scripts"]["test"]
    tokens = shlex.split(command)
    patterns = tokens[tokens.index("--test") + 1:]
    if not patterns or any(not item.startswith("test/") for item in patterns):
        raise ValueError("Expected only unit entry paths after --test")
    entries = []
    for pattern in patterns:
        matches = sorted(glob.glob(pattern, root_dir=source))
        if not matches:
            raise ValueError(f"Entry pattern matched nothing: {pattern}")
        entries.extend(matches)
    if len(set(entries)) != len(entries):
        raise ValueError("Duplicate unit entries")
    return entries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--home-parent", type=Path, required=True)
    parser.add_argument("--tmp-parent", type=Path, required=True)
    parser.add_argument("--entries-manifest", type=Path, required=True)
    args = parser.parse_args()
    source, node, output = args.source.resolve(), args.node.resolve(), args.output.resolve()
    entries = expand_entries(source)
    expected = read_json(args.entries_manifest)["original_unit_entries"]
    if entries != expected:
        raise ValueError("Expanded suite differs from original_unit_entries")
    # Durable HOME must not be under /tmp or an ESM source package. Fixture
    # TMPDIR must be neutral: extensionless CommonJS executables depend on it.
    home_parent, tmp_parent = args.home_parent.resolve(), args.tmp_parent.resolve()
    if home_parent.is_relative_to("/tmp") or home_parent.is_relative_to(source):  # noqa: S108 - reject unsuitable HOME roots

        raise ValueError("HOME parent must be outside /tmp and the source checkout")
    if tmp_parent.is_relative_to(source):
        raise ValueError("TMPDIR parent must be outside the source checkout")
    for parent in [home_parent, tmp_parent]:
        if any((ancestor / "package.json").exists() for ancestor in [parent, *parent.parents]):
            raise ValueError("Isolation parent must not inherit a package.json")
    output.mkdir(parents=True, exist_ok=False)
    home = Path(tempfile.mkdtemp(prefix="baseline-home-", dir=home_parent))
    tmp = Path(tempfile.mkdtemp(prefix="baseline-tmp-", dir=tmp_parent))
    env = {"PATH": f"{node.parent}:{os.defpath}", "HOME": str(home),
           "TMPDIR": str(tmp), "NODE_V8_COVERAGE": str(output / "v8"),
           "XDG_CONFIG_HOME": str(home / ".config"), "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_CONFIG_GLOBAL": "/dev/null"}
    reporter = Path(__file__).with_name("baseline-reporter.ts").resolve()
    command = [str(node), "--experimental-strip-types", "--enable-source-maps",
               "--experimental-test-coverage", "--test-coverage-include=maestro/**",
               "--test-coverage-include=pi-extension/**", "--test",
               f"--test-reporter={reporter}",
               f"--test-reporter-destination={output / 'baseline.jsonl'}",
               "--test-reporter=tap",
               f"--test-reporter-destination={output / 'baseline.tap'}", *entries]
    with (output / "stderr.log").open("w") as stderr:
        result = subprocess.run(command, cwd=source, env=env, stderr=stderr, check=False)
    version = subprocess.check_output([str(node), "--version"], env=env, text=True).strip()
    (output / "run.json").write_text(json.dumps({"node": version,
        "exit_code": result.returncode, "original_unit_entries": entries}, indent=2) + "\n")
    # Keep failed attempts, HOME, TMPDIR and raw source-map evidence private.
    print(f"Capture exit {result.returncode}; private evidence: {output}")
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
