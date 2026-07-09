import { useEffect, useRef, useState } from "react";
import { ChevronRight, ChevronDown, Folder, FolderOpen, FileText } from "lucide-react";
import clsx from "clsx";
import type { TreeNode } from "../api/client";

interface TreeViewProps {
  node: TreeNode;
  depth?: number;
  /** Cluster-path prefix accumulated from the root (e.g. "L1/L2"); empty at the root. */
  path?: string;
  onOpenPaperId?: (paperId: string) => void;
  searchQuery?: string;
  /** When set to a cluster path, auto-expands its ancestors and scrolls it into view. */
  focusPath?: string | null;
}

export function TreeView({
  node, depth = 0, path = "", onOpenPaperId, searchQuery = "", focusPath,
}: TreeViewProps) {
  const [open, setOpen] = useState(depth < 2);
  const rowRef = useRef<HTMLButtonElement>(null);
  const searching = searchQuery.trim().length > 0;
  const filteredNode = depth === 0 ? filterTree(node, searchQuery) : node;

  const isAncestorOfFocus =
    depth > 0 && !!focusPath && (focusPath === path || focusPath.startsWith(path + "/"));
  const isFocusTarget = depth > 0 && !!focusPath && focusPath === path;

  useEffect(() => {
    if (isFocusTarget) rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [isFocusTarget]);

  if (!filteredNode) return null;

  if (filteredNode.type === "paper") {
    const label = paperLabel(filteredNode);
    const meta = [filteredNode.author, filteredNode.year].filter(Boolean).join(" · ");
    return (
      <button
        type="button"
        className={clsx(
          "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left",
          "text-muted hover:text-ink hover:bg-rim/50 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50",
          !filteredNode.paper_id && "cursor-default opacity-60"
        )}
        style={{ paddingLeft: `${depth * 11 + 8}px` }}
        onClick={() => filteredNode.paper_id && onOpenPaperId?.(filteredNode.paper_id)}
        disabled={!filteredNode.paper_id}
        aria-label={`Open ${label}`}
      >
        <FileText size={12} className="shrink-0 text-wire" />
        <span className="min-w-0 flex-1 leading-5">
          <span className="block truncate text-[13px]">{label}</span>
          {meta && <span className="block truncate text-[10px] text-wire">{meta}</span>}
        </span>
        {filteredNode.status && (
          <span
            className={clsx(
              "shrink-0 text-[10px] px-1.5 py-0.5 rounded font-semibold",
              filteredNode.status === "read"
                ? "bg-emerald-500/12 text-emerald-400"
                : "bg-amber-500/12 text-amber-400"
            )}
          >
            {filteredNode.status === "read" ? "read" : "to-read"}
          </span>
        )}
      </button>
    );
  }

  const children = filteredNode.children ?? [];
  const expanded = searching || open || isAncestorOfFocus;
  const Icon    = expanded ? FolderOpen : Folder;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const isRoot  = depth === 0;

  return (
    <div>
      <button
        ref={rowRef}
        type="button"
        className={clsx(
          "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50",
          isRoot
            ? "text-zinc-300 hover:text-ink hover:bg-rim/40"
            : "text-zinc-400 hover:text-zinc-200 hover:bg-rim/40",
          isFocusTarget && "bg-cyan-500/10 ring-1 ring-cyan-400/50"
        )}
        style={{ paddingLeft: `${depth * 11 + 8}px` }}
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${filteredNode.name}`}
      >
        <Chevron size={12} className="shrink-0 text-wire" />
        <Icon
          size={13}
          className={clsx(
            "shrink-0",
            depth === 1 ? "text-cyan-500/70" : "text-violet-500/70"
          )}
        />
        <span className={clsx("truncate", isRoot ? "text-[13px] font-semibold" : "text-[13px] font-medium")}>
          {filteredNode.name}
        </span>
        {children.length > 0 && (
          <span className="text-[10px] text-wire ml-auto shrink-0 tabular-nums">
            {children.length}
          </span>
        )}
      </button>
      {expanded && (
        <div>
          {children.map((child, i) => (
            <TreeView
              key={`${child.name}-${i}`}
              node={child}
              depth={depth + 1}
              path={depth === 0 ? child.name : `${path}/${child.name}`}
              onOpenPaperId={onOpenPaperId}
              searchQuery={searchQuery}
              focusPath={focusPath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function paperLabel(node: TreeNode) {
  return node.title || node.filename?.replace(/\.pdf$/i, "") || cleanName(node.name);
}

function cleanName(name: string) {
  return name.replace(/\.pdf$/i, "").replace(/_(read|toread)$/, "").replace(/_/g, " ");
}

function nodeSearchText(node: TreeNode): string {
  return [node.name, node.title, node.author, node.year, node.filename]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function filterTree(node: TreeNode, query: string): TreeNode | null {
  const q = query.trim().toLowerCase();
  if (!q) return node;

  const selfMatches = nodeSearchText(node).includes(q);
  const children = (node.children ?? [])
    .map(child => filterTree(child, query))
    .filter((child): child is TreeNode => child !== null);

  if (selfMatches || children.length > 0) return { ...node, children };
  return null;
}
