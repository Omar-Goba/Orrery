import { useState } from "react";
import { ChevronRight, ChevronDown, Folder, FolderOpen, FileText } from "lucide-react";
import clsx from "clsx";
import type { TreeNode } from "../api/client";

interface TreeViewProps {
  node: TreeNode;
  depth?: number;
  onOpenPaperId?: (paperId: string) => void;
}

export function TreeView({ node, depth = 0, onOpenPaperId }: TreeViewProps) {
  const [open, setOpen] = useState(depth < 2);

  if (node.type === "paper") {
    return (
      <div
        className={clsx(
          "flex items-center gap-2 py-[3px] px-2 rounded-md cursor-pointer",
          "text-muted hover:text-ink hover:bg-rim/50 transition-colors"
        )}
        style={{ paddingLeft: `${depth * 11 + 8}px` }}
        onClick={() => node.paper_id && onOpenPaperId?.(node.paper_id)}
      >
        <FileText size={12} className="shrink-0 text-wire" />
        <span className="text-[12px] truncate flex-1 leading-5">
          {node.name.replace(/\.pdf$/i, "").replace(/_(read|toread)$/, "").replace(/_/g, " ")}
        </span>
        {node.status && (
          <span
            className={clsx(
              "shrink-0 text-[9px] px-1.5 py-0.5 rounded font-semibold",
              node.status === "read"
                ? "bg-emerald-500/12 text-emerald-400"
                : "bg-amber-500/12 text-amber-400"
            )}
          >
            {node.status === "read" ? "r" : "tr"}
          </span>
        )}
      </div>
    );
  }

  const children = node.children ?? [];
  const Icon    = open ? FolderOpen : Folder;
  const Chevron = open ? ChevronDown : ChevronRight;
  const isRoot  = depth === 0;

  return (
    <div>
      <div
        className={clsx(
          "flex items-center gap-2 py-1 px-2 rounded-md cursor-pointer transition-colors",
          isRoot
            ? "text-zinc-300 hover:text-ink hover:bg-rim/40"
            : "text-zinc-400 hover:text-zinc-200 hover:bg-rim/40"
        )}
        style={{ paddingLeft: `${depth * 11 + 8}px` }}
        onClick={() => setOpen(!open)}
      >
        <Chevron size={12} className="shrink-0 text-wire" />
        <Icon
          size={13}
          className={clsx(
            "shrink-0",
            depth === 1 ? "text-cyan-500/70" : "text-violet-500/70"
          )}
        />
        <span className={clsx("truncate", isRoot ? "text-[12px] font-semibold" : "text-[12px] font-medium")}>
          {node.name}
        </span>
        {children.length > 0 && (
          <span className="text-[10px] text-wire ml-auto shrink-0 tabular-nums">
            {children.length}
          </span>
        )}
      </div>
      {open && (
        <div>
          {children.map((child, i) => (
            <TreeView
              key={`${child.name}-${i}`}
              node={child}
              depth={depth + 1}
              onOpenPaperId={onOpenPaperId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
