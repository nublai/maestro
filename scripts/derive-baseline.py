#!/usr/bin/env python3
"""Reproduce sanitized archives and original-file coverage from Node reports."""
import argparse
import gzip
import json
from pathlib import Path


def load(path):
    try:
        text = gzip.decompress(path.read_bytes()).decode() if path.suffix == ".gz" else path.read_text()
        try:
            return json.loads(text)
        except ValueError:
            return [json.loads(line) for line in text.splitlines() if line.strip()]
    except (OSError, ValueError) as error:
        raise ValueError(f"Cannot read report: {path}") from error


def relative_path(path):
    if not path or Path(path).is_absolute() or ".." in Path(path).parts or "://" in path:
        raise ValueError("Reports must use repository-relative paths")
    return path.split("?", 1)[0]


def derive_coverage(report, template, pin_floors=False):
    files = report["files"]
    groups = {}
    for index, file in enumerate(files):
        path = relative_path(file["path"])
        groups.setdefault(path, []).append((index, file))
    if set(groups) != {file["source"] for file in template["original_files"]}:
        raise ValueError("Coverage population differs from original_files")
    for original in template["original_files"]:
        variants = groups[original["source"]]
        # Query-loaded instances are one original file, never extra mean samples.
        hits = {}
        for _, file in variants:
            for line in file["lines"]:
                hits[line["line"]] = max(hits.get(line["line"], 0), line["count"])
        if not hits:
            raise ValueError("Missing line hit records")
        original["covered_lines"] = sum(count > 0 for count in hits.values())
        original["total_lines"] = len(hits)
        original["line"] = 100 * original["covered_lines"] / len(hits)
        original["branch_function_variants"] = [
            {"branch": file["coveredBranchPercent"], "function": file["coveredFunctionPercent"],
             "report_index": index} for index, file in variants]
    for name, metric in template["metrics"].items():
        cohort = [file for file in template["original_files"] if file["population"] == name]
        mean = sum(file["line"] for file in cohort) / len(cohort)
        if pin_floors:
            metric["floor_line_mean"] = mean
        metric.update({"files": len(cohort), "observed_arithmetic_line_mean": mean,
                       "observed_weighted_line_percent":
                       100 * sum(file["covered_lines"] for file in cohort) /
                       sum(file["total_lines"] for file in cohort)})
    return template


def derive_identities(events):
    identities = [event for event in events if event["type"] in ("test:pass", "test:fail")]
    # Node IDs restart in each entry process. Keep file in the lookup key.
    by_id = {(event["file"], event["testId"]): event for event in identities}
    result = []
    for event in identities:
        relative_path(event["file"])
        titles, current, seen = [], event, set()
        while current:
            key = (current["file"], current["testId"])
            if key in seen:
                raise ValueError("Cyclic identity lineage")
            seen.add(key)
            titles.insert(0, current["name"])
            parent = current.get("parentId", 0)
            current = by_id.get((current["file"], parent)) if parent else None
            if parent and current is None:
                raise ValueError("Missing parent identity")
        if len(titles) != event["nesting"] + 1:
            raise ValueError("Incomplete nested title lineage")
        result.append({**event, "titles": titles, "owner": "pi-herdr-agents",
                       "destination": event["file"], "migration_status": "not-migrated"})
    return result


def archive(path, value):
    # No source paths, timestamps or original filename in the gzip header.
    path.write_bytes(gzip.compress(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode(), mtime=0))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--coverage-report", type=Path, required=True)
    parser.add_argument("--identity-report", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--pin-floors", action="store_true", help="Only for a newly authorized upstream pin")
    args = parser.parse_args()
    coverage = load(args.coverage_report)
    template = load(args.manifest)
    if not isinstance(template, dict):
        raise ValueError("Coverage manifest must be an object")
    if isinstance(coverage, list):
        summaries = [event["data"] for event in coverage if event["type"] == "test:summary"
                     and not event["data"].get("file")]
        if len(summaries) != 1:
            raise ValueError("Expected one complete coverage-run summary")
        template["counts"] = summaries[0]["counts"]
        coverage = next(event for event in coverage if event["type"] == "test:coverage")
    identities = derive_identities(load(args.identity_report))
    if not identities:
        raise ValueError("No structured test identities")
    manifest = derive_coverage(coverage, template, args.pin_floors)
    args.output.mkdir(parents=True, exist_ok=False)
    archive(args.output / "coverage.json.gz", coverage)
    archive(args.output / "test-identities.json.gz", identities)
    (args.output / "coverage-manifest.json").write_text(json.dumps(manifest, indent="\t", ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
