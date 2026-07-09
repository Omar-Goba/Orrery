# AGENTS.md

## Clustering Rules

- Keep cluster output as `ClusterNode` trees; downstream code expects leaves to carry `paper_ids` and internal nodes to carry `children`.
- Tune clustering constants carefully because they directly affect generated folder structure.
- Folder names must remain safe for filesystem paths; preserve sanitization in `ClusterNamer` or equivalent logic.
- Do not make cluster naming depend on committed runtime data from `dbs/`.
