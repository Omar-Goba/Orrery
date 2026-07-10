from __future__ import annotations
import json
import re
from collections.abc import Mapping

from backend.clustering.hierarchical import ClusterNode, ClusterTree
from backend.config import settings
from backend.models import PaperRecord
from backend.services.llm import client_for_role

_PROMPT_TEMPLATE = """\
You are a file system organizer. Given a list of research paper titles, \
generate a concise folder name in Title Case (2-4 words, no numbers, no explanation, no punctuation).

Papers:
{titles}

Folder name (Title Case words only, nothing else):"""


class ClusterNamer:
    def __init__(self) -> None:
        self._client = client_for_role(settings.llm_namer)
        self._model = settings.llm_namer.model

    async def name_cluster(self, paper_summaries: list[str]) -> str:
        if not paper_summaries:
            return "misc_papers"
        titles = "\n".join(f"- {s[:120]}" for s in paper_summaries[:12])
        prompt = _PROMPT_TEMPLATE.format(titles=titles)
        try:
            resp = await self._client.chat.completions.create(
                model=self._model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0,
            )
            raw = resp.choices[0].message.content or ""
            return self._sanitize(raw)
        except Exception:
            return self._sanitize(paper_summaries[0])

    async def name_tree(
        self,
        tree: ClusterTree,
        records: Mapping[str, PaperRecord],
    ) -> None:
        nodes = self._collect_nodes(tree)
        misc_ids = {node_id for node_id, node in nodes.items() if node.name == "Misc"}
        target_ids = [node_id for node_id in nodes if node_id not in misc_ids]

        names: dict[str, str] = {}
        if target_ids:
            names = await self._name_tree_llm(tree, records, target_ids)

        invalid = self._invalid_name_ids(tree, nodes, names, target_ids)
        if invalid:
            repaired = await self._repair_names_llm(tree, records, names, invalid)
            names.update(repaired)
            invalid = self._invalid_name_ids(tree, nodes, names, target_ids)

        for node_id in invalid:
            names[node_id] = await self.name_cluster(self._node_descriptions(nodes[node_id], records))

        for node_id in target_ids:
            nodes[node_id].name = self._sanitize(names.get(node_id, ""))
        for node_id in misc_ids:
            nodes[node_id].name = "Misc"

        self._dedupe_siblings(tree)

    async def _name_tree_llm(
        self,
        tree: ClusterTree,
        records: Mapping[str, PaperRecord],
        target_ids: list[str],
    ) -> dict[str, str]:
        prompt = self._tree_prompt(tree, records, target_ids)
        try:
            resp = await self._client.chat.completions.create(
                model=self._model,
                messages=[
                    {"role": "system", "content": _TREE_SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                temperature=0,
                response_format={"type": "json_object"},
            )
            content = resp.choices[0].message.content or "{}"
            return self._parse_name_map(content)
        except Exception:
            return {}

    async def _repair_names_llm(
        self,
        tree: ClusterTree,
        records: Mapping[str, PaperRecord],
        current_names: dict[str, str],
        invalid_ids: set[str],
    ) -> dict[str, str]:
        prompt = self._tree_prompt(tree, records, sorted(invalid_ids))
        taken = self._taken_sibling_names(tree, current_names, invalid_ids)
        repair_prompt = (
            f"Repair only these node ids: {sorted(invalid_ids)}\n"
            f"Already taken sibling names: {taken}\n"
            f"Return strict JSON mapping each listed node id to a replacement name.\n\n"
            f"{prompt}"
        )
        try:
            resp = await self._client.chat.completions.create(
                model=self._model,
                messages=[
                    {"role": "system", "content": _TREE_SYSTEM_PROMPT},
                    {"role": "user", "content": repair_prompt},
                ],
                temperature=0,
                response_format={"type": "json_object"},
            )
            content = resp.choices[0].message.content or "{}"
            parsed = self._parse_name_map(content)
            return {node_id: parsed[node_id] for node_id in invalid_ids if node_id in parsed}
        except Exception:
            return {}

    def _sanitize(self, raw: str) -> str:
        lines = raw.strip().splitlines()
        if not lines:
            return "Cluster"
        line = lines[0].strip()
        # Strip punctuation/special chars but keep letters, digits, spaces
        line = re.sub(r"[^\w\s]", "", line)
        # Collapse whitespace
        line = re.sub(r"\s+", " ", line).strip()
        # Title-case each word
        line = " ".join(w.capitalize() for w in line.split())
        return line[:60] or "Cluster"

    def _collect_nodes(self, tree: ClusterTree) -> dict[str, ClusterNode]:
        nodes: dict[str, ClusterNode] = {}

        def walk(node: ClusterNode, node_id: str) -> None:
            nodes[node_id] = node
            for index, child in enumerate(node.children):
                walk(child, f"{node_id}.{index}")

        for index, node in enumerate(tree):
            walk(node, f"n{index}")
        return nodes

    def _tree_prompt(
        self,
        tree: ClusterTree,
        records: Mapping[str, PaperRecord],
        target_ids: list[str],
    ) -> str:
        target_set = set(target_ids)
        lines = [
            "Name the requested cluster tree nodes.",
            "Rules: 2-4 words, Title Case, no punctuation, no numbers, specific names only.",
            "Sibling names must be mutually distinct. Child names must not repeat parent words.",
            "Avoid generic names like Machine Learning, Deep Learning Methods, or Research Papers.",
            "Return strict JSON only: {\"node_id\": \"Name\"}.",
            "",
            "Tree:",
        ]

        def walk(node: ClusterNode, node_id: str) -> None:
            if node_id in target_set:
                if node.is_leaf:
                    descriptions = self._node_descriptions(node, records)[:10]
                    lines.append(f"{node_id}: leaf")
                    for description in descriptions:
                        lines.append(f"- {description[:150]}")
                else:
                    child_ids = [f"{node_id}.{index}" for index, _ in enumerate(node.children)]
                    lines.append(f"{node_id}: internal children={child_ids}")
            for index, child in enumerate(node.children):
                walk(child, f"{node_id}.{index}")

        for index, node in enumerate(tree):
            walk(node, f"n{index}")
        return "\n".join(lines)

    def _node_descriptions(
        self,
        node: ClusterNode,
        records: Mapping[str, PaperRecord],
    ) -> list[str]:
        descriptions: list[str] = []
        paper_ids = node.paper_ids if node.is_leaf else node.all_paper_ids()
        for paper_id in paper_ids:
            record = records.get(paper_id)
            if not record:
                continue
            description = record.summary or record.title or record.filename
            if description:
                descriptions.append(description)
        return descriptions or [node.name or "Cluster"]

    def _parse_name_map(self, content: str) -> dict[str, str]:
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            return {}
        if not isinstance(parsed, dict):
            return {}
        names: dict[str, str] = {}
        for key, value in parsed.items():
            if isinstance(key, str) and isinstance(value, str):
                names[key] = self._sanitize(value)
        return names

    def _invalid_name_ids(
        self,
        tree: ClusterTree,
        nodes: Mapping[str, ClusterNode],
        names: Mapping[str, str],
        target_ids: list[str],
    ) -> set[str]:
        invalid = {node_id for node_id in target_ids if not names.get(node_id)}

        def walk(siblings: list[ClusterNode], sibling_ids: list[str], parent_name: str = "") -> None:
            seen: dict[str, str] = {}
            parent_words = self._name_words(parent_name)
            for node, node_id in zip(siblings, sibling_ids, strict=False):
                if node.name == "Misc":
                    name = "Misc"
                else:
                    name = self._sanitize(names.get(node_id, ""))
                lowered = name.lower()
                if not name or lowered in seen:
                    invalid.add(node_id)
                    if lowered in seen:
                        invalid.add(seen[lowered])
                else:
                    seen[lowered] = node_id
                if parent_words and len(parent_words & self._name_words(name)) >= 2:
                    invalid.add(node_id)
                if node.children:
                    child_ids = [f"{node_id}.{index}" for index, _ in enumerate(node.children)]
                    walk(node.children, child_ids, name)

        top_ids = [f"n{index}" for index, _ in enumerate(tree)]
        walk(tree, top_ids)
        return {node_id for node_id in invalid if node_id in nodes and nodes[node_id].name != "Misc"}

    def _taken_sibling_names(
        self,
        tree: ClusterTree,
        names: Mapping[str, str],
        invalid_ids: set[str],
    ) -> dict[str, list[str]]:
        taken: dict[str, list[str]] = {}

        def walk(siblings: list[ClusterNode], sibling_ids: list[str]) -> None:
            clean_names = [
                self._sanitize(names.get(node_id, ""))
                for node_id in sibling_ids
                if node_id not in invalid_ids and names.get(node_id)
            ]
            for node_id in sibling_ids:
                if node_id in invalid_ids:
                    taken[node_id] = clean_names
            for node, node_id in zip(siblings, sibling_ids, strict=False):
                child_ids = [f"{node_id}.{index}" for index, _ in enumerate(node.children)]
                walk(node.children, child_ids)

        walk(tree, [f"n{index}" for index, _ in enumerate(tree)])
        return taken

    def _dedupe_siblings(self, siblings: list[ClusterNode]) -> None:
        used: dict[str, int] = {}
        for node in siblings:
            base = self._sanitize(node.name)
            count = used.get(base.lower(), 0) + 1
            used[base.lower()] = count
            node.name = base if count == 1 else f"{base} {count}"
            if node.children:
                self._dedupe_siblings(node.children)

    def _name_words(self, name: str) -> set[str]:
        return {word.lower() for word in re.findall(r"[A-Za-z]{3,}", name)}


_TREE_SYSTEM_PROMPT = """\
You name research-paper folder trees. Return strict JSON only.
Names must be 2-4 Title Case words with no punctuation and no numbers.
Sibling names must be distinct. Child names must avoid repeating parent words.
Prefer specific topical names over generic labels.
"""
