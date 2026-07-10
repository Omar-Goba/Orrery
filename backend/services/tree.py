"""The virtual cluster tree (plan §10.2).

Replaces `FilesystemService.rebuild_tree` / the `dbs/output/` symlink
forest. Every `PaperRecord` already carries `cluster_path`
(`"Folder/Subfolder"`); the tree the frontend renders is a pure function of
the in-memory records — no disk I/O, no symlinks, no `output_new` swap
dance. `GET /api/tree` calls `build_tree()` directly.
"""
from __future__ import annotations

import re

from backend.models import PaperRecord, TreeNode


def build_tree(records: dict[str, PaperRecord]) -> TreeNode:
    """Group records by `cluster_path` segments; sort folders-first; O(n).

    Records without a `cluster_path` (never clustered/reindexed yet) are
    placed directly under the root rather than silently omitted — the old
    symlink walk could only show what `rebuild_tree` had bothered to link,
    which meant unclustered papers were invisible. Surfacing them here is a
    deliberate, documented improvement over that behavior.
    """
    root = TreeNode(name="library", type="folder")
    folders: dict[tuple[str, ...], TreeNode] = {(): root}

    def _folder(path_parts: tuple[str, ...]) -> TreeNode:
        existing = folders.get(path_parts)
        if existing is not None:
            return existing
        parent = _folder(path_parts[:-1])
        node = TreeNode(name=path_parts[-1], type="folder")
        parent.children.append(node)
        folders[path_parts] = node
        return node

    for record in records.values():
        segments = tuple(
            seg for seg in (record.cluster_path or "").split("/") if seg
        )
        parent = _folder(segments)
        parent.children.append(
            TreeNode(
                name=_leaf_display_name(record),
                type="paper",
                paper_id=record.id,
                status=record.status,
                title=record.title,
                author=record.author,
                year=record.year,
                filename=record.filename,
            )
        )

    _sort_children(root)
    return root


def _sort_children(node: TreeNode) -> None:
    for child in node.children:
        if child.type == "folder":
            _sort_children(child)
    # Folders before papers, then alphabetical — matches the old
    # `path.iterdir()` sort key of `(is_file, name.lower())`.
    node.children.sort(key=lambda n: (n.type != "folder", n.name.lower()))


def _leaf_display_name(record: PaperRecord) -> str:
    """Reproduce the old symlink-forest leaf name, purely for display.

    This is cosmetic continuity, not storage: the pre-Phase-2 tree's leaf
    "name" was `FilesystemService.make_symlink_name` — an
    author/year/title/status slug used as the literal symlink filename. That
    string is still what the frontend tree view expects to render for a
    paper node, so it's reproduced here on the fly rather than persisted
    anywhere (there is no more `symlink_name` field on `PaperRecord`).
    """
    author = _slugify(record.author or "unknown")
    year = record.year or "0000"
    title = record.title or record.filename
    title_slug = "_".join(_slugify(w) for w in title.split()[:5])
    return f"{author}{year}_{title_slug}_{record.status}.pdf"


def _slugify(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[^\w\s]", "", s)
    s = re.sub(r"\s+", "_", s.strip())
    return s[:20] or "x"
