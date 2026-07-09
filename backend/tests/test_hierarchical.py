from backend.clustering.hierarchical import ClusterNode, HierarchicalClusterer


def test_cluster_empty_input_returns_empty_tree() -> None:
    assert HierarchicalClusterer().cluster([], []) == []


def test_small_input_becomes_single_leaf() -> None:
    tree = HierarchicalClusterer().cluster(
        ["p1", "p2", "p3"],
        [[1.0, 0.0], [0.99, 0.01], [0.98, 0.02]],
    )

    assert len(tree) == 1
    assert tree[0].is_leaf
    assert tree[0].paper_ids == ["p1", "p2", "p3"]


def test_extract_outliers_moves_only_clear_outlier_to_misc_bucket() -> None:
    clusterer = HierarchicalClusterer()
    leaf = ClusterNode(paper_ids=[f"p{i}" for i in range(11)])
    vectors_by_id = {f"p{i}": [1.0, 0.0] for i in range(10)}
    vectors_by_id["p10"] = [-1.0, 0.0]

    extracted = clusterer._extract_outliers(leaf, vectors_by_id)

    assert extracted == ["p10"]
    assert leaf.paper_ids == [f"p{i}" for i in range(10)]
