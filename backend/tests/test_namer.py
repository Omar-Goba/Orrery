import pytest

from backend.clustering.hierarchical import ClusterNode
from backend.clustering.namer import ClusterNamer
from backend.models import PaperRecord


@pytest.mark.asyncio
async def test_name_tree_fallback_dedupes_sibling_names(monkeypatch: pytest.MonkeyPatch) -> None:
    namer = ClusterNamer()
    monkeypatch.setattr("backend.clustering.namer.settings.openai_api_key", "")

    async def fake_name_cluster(_: list[str]) -> str:
        return "Neural Methods"

    monkeypatch.setattr(namer, "name_cluster", fake_name_cluster)
    tree = [
        ClusterNode(paper_ids=["p1"]),
        ClusterNode(paper_ids=["p2"]),
    ]
    records = {
        "p1": PaperRecord(
            id="p1",
            filename="a.pdf",
            original_path="a.pdf",
            status="toread",
            summary="Graph neural networks for molecules.",
        ),
        "p2": PaperRecord(
            id="p2",
            filename="b.pdf",
            original_path="b.pdf",
            status="toread",
            summary="Transformer models for vision.",
        ),
    }

    await namer.name_tree(tree, records)

    assert [node.name for node in tree] == ["Neural Methods", "Neural Methods 2"]


@pytest.mark.asyncio
async def test_name_tree_preserves_misc(monkeypatch: pytest.MonkeyPatch) -> None:
    namer = ClusterNamer()
    monkeypatch.setattr("backend.clustering.namer.settings.openai_api_key", "")

    async def fake_name_cluster(_: list[str]) -> str:
        return "Main Topic"

    monkeypatch.setattr(namer, "name_cluster", fake_name_cluster)
    tree = [
        ClusterNode(paper_ids=["p1"]),
        ClusterNode(name="Misc", paper_ids=["p2"]),
    ]
    records = {
        "p1": PaperRecord(id="p1", filename="a.pdf", original_path="a.pdf", status="toread"),
        "p2": PaperRecord(id="p2", filename="b.pdf", original_path="b.pdf", status="toread"),
    }

    await namer.name_tree(tree, records)

    assert tree[0].name == "Main Topic"
    assert tree[1].name == "Misc"
