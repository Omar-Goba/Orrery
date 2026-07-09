from __future__ import annotations
import os
import re
import shutil
from pathlib import Path

from backend.config import settings
from backend.models import PaperRecord, TreeNode


class FilesystemService:
    def __init__(self) -> None:
        self._output_dir = settings.output_dir

    # ── tree rebuild ───────────────────────────────────────────────────────

    def rebuild_tree(
        self,
        cluster_tree: list,          # list[ClusterNode] — arbitrary depth
        records: dict[str, PaperRecord],
    ) -> None:
        tmp = self._output_dir.parent / "output_new"
        if tmp.exists():
            shutil.rmtree(tmp)
        tmp.mkdir(parents=True)

        for node in cluster_tree:
            self._write_node(node, tmp, records)

        # Only remove the old output if it contains no real PDF files
        # (i.e., it's already a pure symlink tree). If it has real files,
        # those are original papers — move them to input/ to preserve them.
        if self._output_dir.exists():
            real_pdfs = [
                p for p in self._output_dir.rglob("*.pdf")
                if not p.is_symlink()
            ]
            if real_pdfs:
                rescue_dir = self._output_dir.parent / "input"
                rescue_dir.mkdir(exist_ok=True)
                for pdf in real_pdfs:
                    dest = rescue_dir / pdf.name
                    if not dest.exists():
                        shutil.copy2(str(pdf), str(dest))
            shutil.rmtree(self._output_dir)
        shutil.move(str(tmp), str(self._output_dir))

        self._check_broken_symlinks()

    def _write_node(self, node, parent_dir: Path, records: dict[str, PaperRecord]) -> None:
        """Recursively write a ClusterNode tree into the filesystem."""
        node_dir = parent_dir / self._safe_name(node.name or "cluster")
        node_dir.mkdir(exist_ok=True)
        if node.is_leaf:
            for pid in node.paper_ids:
                if pid in records:
                    self._make_symlink(node_dir, records[pid])
        else:
            for child in node.children:
                self._write_node(child, node_dir, records)

    def update_symlink_status(self, record: PaperRecord, old_symlink_name: str) -> None:
        """Rename a single paper's symlink after its status changes."""
        for link in self._output_dir.rglob(old_symlink_name):
            if link.is_symlink():
                folder = link.parent
                link.unlink()
                self._make_symlink(folder, record)
                return

    def _make_symlink(self, folder: Path, record: PaperRecord) -> None:
        name = self.make_symlink_name(record)
        link = folder / name
        target = Path(record.original_path).resolve()
        if link.exists() or link.is_symlink():
            link.unlink()
        try:
            os.symlink(target, link)
        except OSError:
            pass

    def _check_broken_symlinks(self) -> None:
        for link in self._output_dir.rglob("*"):
            if link.is_symlink() and not link.exists():
                print(f"[warn] broken symlink: {link}")

    # ── naming ─────────────────────────────────────────────────────────────

    def make_symlink_name(self, record: PaperRecord) -> str:
        author = self._slugify(record.author or "unknown")
        year = record.year or "0000"
        title = record.title or record.filename
        title_slug = "_".join(self._slugify(w) for w in title.split()[:5])
        status = record.status
        return f"{author}{year}_{title_slug}_{status}.pdf"

    # ── tree JSON ──────────────────────────────────────────────────────────

    def get_tree_json(self, records: dict[str, PaperRecord]) -> TreeNode:
        name_to_record = {r.symlink_name: r for r in records.values() if r.symlink_name}
        root = self._walk_dir(self._output_dir, name_to_record)
        root.name = "library"
        return root

    def _walk_dir(self, path: Path, name_to_record: dict[str, PaperRecord]) -> TreeNode:
        children: list[TreeNode] = []
        try:
            entries = sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except PermissionError:
            return TreeNode(name=path.name, type="folder")

        for entry in entries:
            if entry.name.startswith("."):
                continue
            if entry.is_dir() and not entry.is_symlink():
                children.append(self._walk_dir(entry, name_to_record))
            elif entry.is_symlink() and entry.suffix == ".pdf":
                record = name_to_record.get(entry.name)
                children.append(
                    TreeNode(
                        name=entry.name,
                        type="paper",
                        paper_id=record.id if record else None,
                        status=record.status if record else None,
                        title=record.title if record else None,
                        author=record.author if record else None,
                        year=record.year if record else None,
                        filename=record.filename if record else entry.name,
                    )
                )
        return TreeNode(name=path.name, type="folder", children=children)

    # ── helpers ────────────────────────────────────────────────────────────

    @staticmethod
    def _safe_name(s: str) -> str:
        # Allow letters, digits, spaces, hyphens — strip leading/trailing spaces
        s = re.sub(r"[^\w\s\-]", "", s).strip()
        s = re.sub(r"\s+", " ", s)
        return s[:60] or "Cluster"

    @staticmethod
    def _slugify(s: str) -> str:
        s = s.lower()
        s = re.sub(r"[^\w\s]", "", s)
        s = re.sub(r"\s+", "_", s.strip())
        return s[:20] or "x"
