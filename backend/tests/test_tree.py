"""Unit tests for `backend.services.tree.build_tree` (plan §10.2).

The critical test here is `test_build_tree_matches_pre_refactor_snapshot`:
before `FilesystemService.rebuild_tree` / `get_tree_json` (the symlink-walk
code) was deleted, we ran it against a synthesized representative library
(8 papers across 2-3 cluster_path depths, mixed read/toread statuses) and
recorded its exact JSON output to
`tests/fixtures/tree_snapshot_expected.json`. The generating script is
reproduced in this file's module docstring below for provenance. This test
asserts the new pure-function `build_tree()` produces byte-for-byte the
same structure from the same records, satisfying the phase-2 gate
("§10 rules hold; tree JSON deep-equals old output").

Regenerating the golden snapshot (only ever needed if the *legacy* symlink
code is resurrected for comparison, which it shouldn't be — this file is
frozen provenance for a deleted code path):

    Settings.output_dir = property(lambda self: self.dbs_dir / "output")
    Settings.input_dir = property(lambda self: self.dbs_dir / "input")
    # ... construct `PaperRecord`s from tests/fixtures/tree_snapshot_records.json,
    # set `symlink_name` via the old `FilesystemService.make_symlink_name`,
    # group by `cluster_path` into a `ClusterTree`, call
    # `FilesystemService.rebuild_tree(tree, records)` against a tmp dbs dir,
    # then `FilesystemService.get_tree_json(records)` and dump `.model_dump(mode="json")`.
"""
from __future__ import annotations

import json
from pathlib import Path

from backend.models import PaperRecord
from backend.services.tree import build_tree

FIXTURES = Path(__file__).parent / "fixtures"


def _load_records() -> dict[str, PaperRecord]:
    raw = json.loads((FIXTURES / "tree_snapshot_records.json").read_text())
    records: dict[str, PaperRecord] = {}
    for entry in raw:
        entry = dict(entry)
        # Old fixture schema used `original_path`; Phase 2 renamed it to a
        # display-only `source_filename` (basename only) and dropped
        # `symlink_name` entirely — convert on the way in.
        entry.pop("original_path", None)
        entry["source_filename"] = entry["filename"]
        records[entry["id"]] = PaperRecord(**entry)
    return records


def test_build_tree_matches_pre_refactor_snapshot() -> None:
    records = _load_records()
    expected = json.loads((FIXTURES / "tree_snapshot_expected.json").read_text())

    actual = build_tree(records).model_dump(mode="json")

    assert actual == expected


def test_build_tree_groups_by_cluster_path_segments() -> None:
    records = {
        "a": PaperRecord(
            id="a", filename="a.pdf", source_filename="a.pdf", status="toread",
            title="A", author="Auth", year="2020", cluster_path="Foo/Bar",
        ),
        "b": PaperRecord(
            id="b", filename="b.pdf", source_filename="b.pdf", status="toread",
            title="B", author="Auth", year="2020", cluster_path="Foo/Bar",
        ),
        "c": PaperRecord(
            id="c", filename="c.pdf", source_filename="c.pdf", status="toread",
            title="C", author="Auth", year="2020", cluster_path="Foo/Baz",
        ),
    }
    tree = build_tree(records)
    assert tree.name == "library"
    assert [c.name for c in tree.children] == ["Foo"]

    foo = tree.children[0]
    assert {c.name for c in foo.children} == {"Bar", "Baz"}

    bar = next(c for c in foo.children if c.name == "Bar")
    assert len(bar.children) == 2
    assert all(c.type == "paper" for c in bar.children)


def test_build_tree_sorts_folders_before_papers_alphabetically() -> None:
    records = {
        "a": PaperRecord(
            id="a", filename="a.pdf", source_filename="a.pdf", status="toread",
            title="Zed Paper", author="Z", year="2020", cluster_path=None,
        ),
        "b": PaperRecord(
            id="b", filename="b.pdf", source_filename="b.pdf", status="toread",
            title="B", author="Auth", year="2020", cluster_path="Alpha",
        ),
    }
    tree = build_tree(records)
    # "Alpha" folder must sort before the root-level paper leaf even though
    # the paper's display name might otherwise sort earlier.
    assert tree.children[0].type == "folder"
    assert tree.children[0].name == "Alpha"
    assert tree.children[-1].type == "paper"


def test_build_tree_surfaces_unclustered_records_at_root() -> None:
    """Records with no `cluster_path` (never reindexed) are placed at the
    root rather than silently dropped — a deliberate improvement over the
    old symlink walk, which could only show what `rebuild_tree` had
    bothered to link and would just omit these entirely."""
    records = {
        "a": PaperRecord(
            id="a", filename="a.pdf", source_filename="a.pdf", status="toread",
            title="Orphan", author="Nobody", year="2020", cluster_path=None,
        ),
    }
    tree = build_tree(records)
    assert len(tree.children) == 1
    assert tree.children[0].type == "paper"
    assert tree.children[0].paper_id == "a"


def test_build_tree_empty_records() -> None:
    tree = build_tree({})
    assert tree.name == "library"
    assert tree.children == []
