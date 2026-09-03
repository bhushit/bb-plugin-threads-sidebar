import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import {
  UrlLink,
  definePluginApp,
  experimental_useProviders,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit,
  experimental_useSidebarThreads,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type {
  PluginSidebarPullRequest,
  PluginSidebarThread,
  PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { threadsSidebarRpcContract } from "./contract.js";
import { Icon } from "./components/ui/icon";
import type { IconName } from "./components/ui/icon";
import {
  MobileTrigger,
  ResponsiveDrawerShell,
} from "./components/ui/responsive-overlay";
import { useIsCompactViewport } from "./components/ui/hooks/use-compact-viewport";
import { cn } from "./lib/utils";
import { usePortalScopeProps } from "./lib/portal-scope";
import {
  DEFAULT_SECTION_CONFIG,
  DEFAULT_VIEW_PREFERENCES,
  organizeThreads,
} from "./organize";
import type {
  Filter,
  Grouping,
  OrganizedRow,
  Sort,
  ViewPreferences,
} from "./organize";
import "./app.css";

const PREFS_KEY = "threads-sidebar:view:v1";
const COLLAPSE_KEY = "threads-sidebar:collapsed:v1";
const EXPANDED_KEY = "threads-sidebar:expanded-parents:v1";

function useStoredState<T>(key: string, fallback: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored ? (JSON.parse(stored) as T) : fallback;
    } catch {
      return fallback;
    }
  });
  const update = (next: T) => {
    setValue(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Preferences are deliberately best-effort and client-local.
    }
  };
  return [value, update];
}

function titleOf(thread: PluginSidebarThread): string {
  return thread.title ?? thread.titleFallback ?? "Untitled thread";
}

function isRunning(thread: PluginSidebarThread): boolean {
  return (
    Object.values(thread.activity).some((count) => count > 0) ||
    [
      "background-agent",
      "background-command",
      "goal",
      "plan-mode",
      "runtime",
      "workflow",
      "working-draft",
    ].includes(thread.indicator)
  );
}

type RowStatus = "attention" | "unread" | "working" | null;

function StatusGlyph({
  status,
  corner = false,
}: {
  status: RowStatus;
  corner?: boolean;
}) {
  if (status === null) return null;
  if (status === "attention")
    return (
      <Icon
        name="MessageQuestion"
        className={`${corner ? "ts-status-corner " : ""}ts-attention`}
      />
    );
  return (
    <span
      className={[
        corner ? "ts-status-corner" : "",
        status === "working" ? "ts-working-dot ts-running" : "ts-unread-dot",
      ].join(" ")}
      aria-hidden="true"
    />
  );
}

function PullRequestProbe({
  threadId,
  onChange,
}: {
  threadId: string;
  onChange: (threadId: string, pullRequest: PluginSidebarPullRequest | null) => void;
}) {
  const { pullRequest } = experimental_useSidebarThreadPullRequest(threadId);
  useEffect(() => onChange(threadId, pullRequest), [onChange, pullRequest, threadId]);
  return null;
}

function ThreadMenu({
  thread,
  beginRename,
}: {
  thread: PluginSidebarThread;
  beginRename: () => void;
}) {
  const actions = experimental_useSidebarThreadActions();
  const rpc = useRpc<typeof threadsSidebarRpcContract>();
  const portalScopeProps = usePortalScopeProps();
  const isCompactViewport = useIsCompactViewport();
  const [open, setOpen] = useState(false);
  const [generatingTitle, setGeneratingTitle] = useState(false);
  const safely = (promise: Promise<void>) =>
    void promise.catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : String(error)),
    );
  const renameWithAi = () => {
    setGeneratingTitle(true);
    void rpc
      .call("renameWithAi", { threadId: thread.id })
      .then(({ title }) => toast.success(`Renamed to “${title}”`))
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setGeneratingTitle(false));
  };

  // Mirrors bb's native thread bottom sheet order, with "Rename with AI"
  // inserted next to the plain rename.
  const items: {
    key: string;
    icon: IconName;
    label: string;
    run: () => void;
    disabled?: boolean;
    destructive?: boolean;
    separatorBefore?: boolean;
  }[] = [
    {
      key: "read",
      icon: thread.isUnread ? "MailOpen" : "Mail",
      label: `Mark ${thread.isUnread ? "read" : "unread"}`,
      run: () => safely(actions.setRead(thread.id, thread.isUnread)),
    },
    {
      key: "pin",
      icon: thread.isPinned ? "PinOff" : "Pin",
      label: thread.isPinned ? "Unpin" : "Pin",
      run: () => safely(actions.setPinned(thread.id, !thread.isPinned)),
    },
    {
      key: "rename",
      icon: "Edit",
      label: "Rename",
      run: beginRename,
    },
    {
      key: "rename-ai",
      icon: "AiContentGenerator01",
      label: generatingTitle ? "Generating title…" : "Rename with AI",
      run: renameWithAi,
      disabled: generatingTitle,
    },
    {
      key: "archive",
      icon: "Archive",
      label: "Archive",
      run: () => actions.archive(thread.id),
    },
    {
      key: "delete",
      icon: "Trash2",
      label: "Delete…",
      run: () => actions.requestDelete(thread.id),
      destructive: true,
      separatorBefore: true,
    },
  ];

  const triggerLabel = `Actions for ${titleOf(thread)}`;

  if (isCompactViewport) {
    return (
      <>
        <MobileTrigger
          open={open}
          onOpenChange={setOpen}
          haspopup="menu"
          className="ts-menu-trigger"
          aria-label={triggerLabel}
          onClick={(event) => {
            // The row is an <a href>; without preventDefault the browser
            // navigates on tap. stopPropagation keeps the row's own open
            // handler from firing. Since preventDefault makes MobileTrigger
            // skip its toggle, drive the open state here.
            event.preventDefault();
            event.stopPropagation();
            setOpen((previous) => !previous);
          }}
        >
          <Icon name="MoreHorizontal" className="size-4" />
        </MobileTrigger>
        <ResponsiveDrawerShell
          open={open}
          onOpenChange={setOpen}
          srLabel={triggerLabel}
          contentClassName="ts-sheet-menu"
        >
          <div className="ts-sheet-list" role="menu">
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={cn(
                  "ts-sheet-item",
                  item.separatorBefore && "ts-sheet-item-divide",
                  item.destructive && "text-destructive",
                )}
                onClick={() => {
                  setOpen(false);
                  item.run();
                }}
              >
                <Icon name={item.icon} className="size-5" />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </ResponsiveDrawerShell>
      </>
    );
  }

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          className="ts-menu-trigger"
          aria-label={triggerLabel}
          onClick={(event) => event.stopPropagation()}
        >
          <Icon name="MoreHorizontal" className="size-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          {...portalScopeProps}
          className="ts-menu"
          sideOffset={4}
          align="end"
        >
          {items.map((item) => (
            <Fragment key={item.key}>
              {item.separatorBefore ? (
                <DropdownMenu.Separator className="ts-menu-separator" />
              ) : null}
              <DropdownMenu.Item
                className={cn(
                  "ts-menu-item",
                  item.destructive && "text-destructive",
                )}
                disabled={item.disabled}
                onSelect={item.run}
              >
                <Icon name={item.icon} className="size-4" /> {item.label}
              </DropdownMenu.Item>
            </Fragment>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ThreadRow({
  row,
  active,
  providerName,
  providerLogoUrl,
  rowStatus,
  showPrBadge,
  showProviderHarness,
  expanded,
  setExpanded,
  onNavigate,
}: {
  row: OrganizedRow;
  active: boolean;
  providerName: string;
  providerLogoUrl: string | null;
  rowStatus: RowStatus;
  showPrBadge: boolean;
  showProviderHarness: boolean;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  onNavigate: () => void;
}) {
  const { thread, depth, childCount } = row;
  const actions = experimental_useSidebarThreadActions();
  const split = experimental_useSidebarThreadSplit(thread.id);
  const { pullRequest } = experimental_useSidebarThreadPullRequest(thread.id);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(titleOf(thread));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);
  useEffect(() => {
    if (!renaming) setDraft(titleOf(thread));
  }, [renaming, thread.title, thread.titleFallback]);

  const saveRename = async () => {
    const next = draft.trim();
    setRenaming(false);
    if (!next || next === titleOf(thread)) return;
    try {
      await actions.rename(thread.id, next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };
  const onRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveRename();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDraft(titleOf(thread));
      setRenaming(false);
    }
  };
  const openThread = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (renaming) return;
    actions.open(thread.id, { split: event.metaKey || event.ctrlKey });
    onNavigate();
  };

  return (
    <div className="ts-row-wrap" style={{ paddingLeft: depth * 10 }}>
      <a
        href={`/threads/${thread.id}`}
        className="ts-row"
        data-active={active ? "" : undefined}
        data-unread={thread.isUnread ? "" : undefined}
        data-sidebar-thread-shortcut-target=""
        data-sidebar-thread-id={thread.id}
        title={titleOf(thread)}
        onClick={openThread}
        onDoubleClick={(event) => {
          event.preventDefault();
          setRenaming(true);
        }}
        {...split.splitProps}
      >
        <span
          className="ts-status"
          aria-label={
            rowStatus === "attention"
              ? "Thread needs user input"
              : rowStatus === "unread"
                ? "Unread thread"
                : rowStatus === "working"
                  ? "Thread is working"
                  : `${providerName} thread`
          }
          title={
            thread.host?.name
              ? `${providerName} · ${thread.host.name}`
              : providerName
          }
        >
          {showProviderHarness ? (
            <span className="ts-provider-mark">
              {providerLogoUrl ? (
                <span
                  className="ts-provider-logo"
                  style={
                    {
                      maskImage: `url("${providerLogoUrl}")`,
                      WebkitMaskImage: `url("${providerLogoUrl}")`,
                    } as CSSProperties
                  }
                />
              ) : (
                <Icon name="Bot" className="size-3.5" />
              )}
              <StatusGlyph status={rowStatus} corner />
            </span>
          ) : (
            <StatusGlyph status={rowStatus} />
          )}
        </span>
        <span className="ts-row-main">
          {renaming ? (
            <input
              ref={inputRef}
              className="ts-rename"
              value={draft}
              aria-label="Thread title"
              onChange={(event) => setDraft(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onBlur={() => void saveRename()}
              onKeyDown={onRenameKeyDown}
            />
          ) : (
            <span className="ts-title">{titleOf(thread)}</span>
          )}
        </span>
        {showPrBadge && pullRequest ? (
          <UrlLink
            href={pullRequest.url}
            className="ts-pr-badge"
            data-state={pullRequest.state}
            data-attention={pullRequest.attention}
            title={pullRequest.title}
            onClick={(event) => event.stopPropagation()}
          >
            <Icon name="GitPullRequest" className="size-3" />
            {pullRequest.number}
          </UrlLink>
        ) : null}
        <ThreadMenu thread={thread} beginRename={() => setRenaming(true)} />
        {childCount > 0 ? (
          <button
            className="ts-fork-badge"
            aria-label={`${expanded ? "Hide" : "Show"} ${childCount} child threads`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setExpanded(!expanded);
            }}
          >
            <Icon
              name={expanded ? "ChevronDown" : "ChevronRight"}
              className="size-3"
            />
            <Icon name="Fork" className="size-3" />
            {childCount}
          </button>
        ) : null}
      </a>
    </div>
  );
}

function ViewRadioItem({
  value,
  children,
}: {
  value: string;
  children: string;
}) {
  return (
    <DropdownMenu.RadioItem className="ts-menu-item ts-radio-item" value={value}>
      <span>{children}</span>
      <DropdownMenu.ItemIndicator className="ts-radio-dot" />
    </DropdownMenu.RadioItem>
  );
}

type ProjectHost = {
  id: string;
  name: string;
  status: "connected" | "disconnected";
};

type HostDirectory = {
  directory: string;
  parent: string | null;
  entries: { kind: "directory" | "file"; name: string; path: string }[];
};

function pathCrumbs(directory: string): { label: string; path: string }[] {
  if (/^[A-Za-z]:/.test(directory)) {
    const segments = directory.replace(/\//g, "\\").split("\\").filter(Boolean);
    const drive = segments[0] ?? "";
    let accumulated = drive;
    return [
      { label: drive, path: `${drive}\\` },
      ...segments.slice(1).map((segment) => {
        accumulated = `${accumulated}\\${segment}`;
        return { label: segment, path: accumulated };
      }),
    ];
  }
  let accumulated = "";
  return [
    { label: "/", path: "/" },
    ...directory
      .split("/")
      .filter(Boolean)
      .map((segment) => {
        accumulated = `${accumulated}/${segment}`;
        return { label: segment, path: accumulated };
      }),
  ];
}

function joinHostPath(directory: string, name: string): string {
  return /^[A-Za-z]:/.test(directory)
    ? `${directory.replace(/[\\/]+$/, "")}\\${name}`
    : `${directory.replace(/\/+$/, "")}/${name}`;
}

function projectNameFromPath(value: string): string {
  return value.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

function NewProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (projectId: string) => void;
}) {
  const rpc = useRpc<typeof threadsSidebarRpcContract>();
  const portalScopeProps = usePortalScopeProps();
  const [hosts, setHosts] = useState<ProjectHost[]>([]);
  const [hostId, setHostId] = useState("");
  const [directory, setDirectory] = useState<HostDirectory | null>(null);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadDirectory = useCallback(
    async (nextHostId: string, nextPath: string | null) => {
      setBrowsing(true);
      setBrowserError(null);
      try {
        const listing = await rpc.call("browseHostDirectory", {
          hostId: nextHostId,
          path: nextPath,
        });
        setDirectory(listing);
        setCurrentPath(listing.directory);
      } catch (error) {
        setDirectory(null);
        setBrowserError(error instanceof Error ? error.message : String(error));
      } finally {
        setBrowsing(false);
      }
    },
    [rpc],
  );

  useEffect(() => {
    if (!open) return;
    setDirectory(null);
    setCurrentPath(null);
    setBrowserError(null);
    void rpc
      .call("listProjectHosts", null)
      .then((nextHosts) => {
        setHosts(nextHosts);
        const nextHostId =
          nextHosts.find((host) => host.status === "connected")?.id ??
            nextHosts[0]?.id ??
            "";
        setHostId(nextHostId);
        if (nextHostId) void loadDirectory(nextHostId, null);
      })
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      );
  }, [loadDirectory, open, rpc]);

  const navigateTo = (nextPath: string) => {
    setNewFolderName(null);
    setCurrentPath(nextPath);
    void loadDirectory(hostId, nextPath);
  };

  const createFolder = async () => {
    const name = newFolderName?.trim() ?? "";
    if (!directory || !name || name === "." || name === ".." || /[\\/]/.test(name))
      return;
    const folderPath = joinHostPath(directory.directory, name);
    try {
      await rpc.call("createHostFolder", { hostId, path: folderPath });
      navigateTo(folderPath);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const createProject = async () => {
    if (!hostId || !directory?.directory) return;
    setLoading(true);
    try {
      const project = await rpc.call("createProject", {
        hostId,
        path: directory.directory,
      });
      toast.success(`Created ${project.name}`);
      onOpenChange(false);
      onCreated(project.projectId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay {...portalScopeProps} className="ts-dialog-overlay" />
        <Dialog.Content {...portalScopeProps} className="ts-dialog">
          <Dialog.Close className="ts-dialog-close" aria-label="Close">
            <Icon name="X" className="size-4" />
          </Dialog.Close>
          <Dialog.Title className="ts-dialog-title">Add project</Dialog.Title>
          <Dialog.Description className="ts-dialog-description">
            Browse to the project folder
            {hosts.find((host) => host.id === hostId)?.name
              ? ` on ${hosts.find((host) => host.id === hostId)?.name}`
              : ""}
            , or edit the path directly.
          </Dialog.Description>
          <div className="ts-machine-select">
            <span className="ts-machine-dot" />
            <select
              aria-label="Machine"
              value={hostId}
              onChange={(event) => {
                setCurrentPath(null);
                setHostId(event.target.value);
                void loadDirectory(event.target.value, null);
              }}
            >
              {hosts.map((host) => (
                <option key={host.id} value={host.id} disabled={host.status !== "connected"}>
                  {host.name}{host.status === "connected" ? "" : " (offline)"}
                </option>
              ))}
            </select>
          </div>
          <div className="ts-path-browser">
            <div className="ts-path-toolbar">
              {editingPath ? (
                <>
                  <input
                    autoFocus
                    aria-label="Project path"
                    value={pathDraft}
                    onChange={(event) => setPathDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && pathDraft.trim()) {
                        setEditingPath(false);
                        navigateTo(pathDraft.trim());
                      } else if (event.key === "Escape") {
                        setEditingPath(false);
                      }
                    }}
                  />
                  <button
                    aria-label="Go to path"
                    onClick={() => {
                      if (!pathDraft.trim()) return;
                      setEditingPath(false);
                      navigateTo(pathDraft.trim());
                    }}
                  >
                    <Icon name="Check" className="size-4" />
                  </button>
                </>
              ) : (
                <>
                  <button
                    aria-label="Go to parent folder"
                    disabled={!directory?.parent}
                    onClick={() => directory?.parent && navigateTo(directory.parent)}
                  >
                    <Icon name="ArrowUp" className="size-4" />
                  </button>
                  <div className="ts-breadcrumbs">
                    {(directory ? pathCrumbs(directory.directory) : []).map(
                      (crumb, index) => (
                        <Fragment key={crumb.path}>
                          {index > 0 ? (
                            <Icon name="ChevronRight" className="size-3" />
                          ) : null}
                          <button onClick={() => navigateTo(crumb.path)}>
                            {crumb.label}
                          </button>
                        </Fragment>
                      ),
                    )}
                  </div>
                  <button
                    aria-label="New folder"
                    disabled={!directory}
                    onClick={() => setNewFolderName("")}
                  >
                    <Icon name="FolderPlus" className="size-4" />
                  </button>
                  <button
                    aria-label="Edit path"
                    disabled={!directory}
                    onClick={() => {
                      setPathDraft(directory?.directory ?? "");
                      setEditingPath(true);
                    }}
                  >
                    <Icon name="Edit" className="size-4" />
                  </button>
                </>
              )}
            </div>
            <div className="ts-directory-list">
              {newFolderName !== null ? (
                <div className="ts-new-folder-row">
                  <Icon name="Folder" className="size-4" />
                  <input
                    autoFocus
                    value={newFolderName}
                    placeholder="Folder name"
                    onChange={(event) => setNewFolderName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void createFolder();
                      if (event.key === "Escape") setNewFolderName(null);
                    }}
                  />
                  <button aria-label="Create folder" onClick={() => void createFolder()}>
                    <Icon name="Check" className="size-4" />
                  </button>
                  <button aria-label="Cancel new folder" onClick={() => setNewFolderName(null)}>
                    <Icon name="X" className="size-4" />
                  </button>
                </div>
              ) : null}
              {browsing ? (
                <div className="ts-browser-state">
                  <Icon name="Spinner" className="size-4 ts-running" /> Loading…
                </div>
              ) : browserError ? (
                <div className="ts-browser-state text-destructive">{browserError}</div>
              ) : directory?.entries.length ? (
                directory.entries.map((entry) =>
                  entry.kind === "directory" ? (
                    <button
                      key={entry.path}
                      className="ts-directory-row"
                      onClick={() => navigateTo(entry.path)}
                    >
                      <Icon name="Folder" className="size-4" />
                      <span>{entry.name}</span>
                      <Icon name="ChevronRight" className="size-4" />
                    </button>
                  ) : (
                    <div key={entry.path} className="ts-directory-row ts-file-row">
                      <Icon name="File" className="size-4" />
                      <span>{entry.name}</span>
                    </div>
                  ),
                )
              ) : directory ? (
                <div className="ts-browser-state">This folder is empty.</div>
              ) : null}
            </div>
          </div>
          {directory?.directory ? (
            <p className="ts-derived-name">
              Project name: <strong>{projectNameFromPath(directory.directory)}</strong>
            </p>
          ) : null}
          <div className="ts-dialog-actions">
            <button
              className="ts-dialog-button ts-dialog-primary"
              disabled={loading || !hostId || !directory?.directory}
              onClick={() => void createProject()}
            >
              {loading ? "Adding…" : "Add project"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ThreadsHeader({
  activeProjectId,
  projects,
  preferences,
  setPreferences,
  onNavigate,
}: {
  activeProjectId: string | null;
  projects: readonly { id: string; name: string; isPersonal: boolean }[];
  preferences: ViewPreferences;
  setPreferences: (next: ViewPreferences) => void;
  onNavigate: () => void;
}) {
  const actions = experimental_useSidebarThreadActions();
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const portalScopeProps = usePortalScopeProps();
  const orderedProjects = [...projects].sort(
    (a, b) =>
      Number(b.isPersonal) - Number(a.isPersonal) || a.name.localeCompare(b.name),
  );
  const openNewThread = (projectId?: string) => {
    actions.openNewThread({ projectId, focusPrompt: true });
    onNavigate();
  };

  return (
    <div className="ts-header">
      <h2>Threads</h2>
      <div className="ts-header-actions">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="ts-header-button" aria-label="New thread">
              <Icon name="Plus" className="size-4" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              {...portalScopeProps}
              className="ts-menu ts-project-menu"
              sideOffset={4}
              align="end"
            >
              <DropdownMenu.Label className="ts-menu-label">
                New thread in…
              </DropdownMenu.Label>
              {orderedProjects.map((project, index) => (
                <Fragment key={project.id}>
                  {index === 1 && orderedProjects[0]?.isPersonal ? (
                    <DropdownMenu.Separator className="ts-menu-separator" />
                  ) : null}
                  <DropdownMenu.Item
                    className="ts-menu-item ts-project-item"
                    onSelect={() => openNewThread(project.id)}
                  >
                    <span>{project.name}</span>
                    {project.id === activeProjectId ? (
                      <span className="ts-current-project">current</span>
                    ) : null}
                  </DropdownMenu.Item>
                </Fragment>
              ))}
              <DropdownMenu.Separator className="ts-menu-separator" />
              <DropdownMenu.Item
                className="ts-menu-item"
                onSelect={() => setNewProjectOpen(true)}
              >
                <Icon name="FolderPlus" className="size-4" />
                New project…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="ts-header-button" aria-label="Thread display options">
              <Icon name="FilterHorizontal" className="size-4" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              {...portalScopeProps}
              className="ts-menu ts-view-menu"
              sideOffset={4}
              align="end"
            >
              <DropdownMenu.Label className="ts-menu-label">Group by</DropdownMenu.Label>
              <DropdownMenu.RadioGroup
                value={preferences.grouping}
                onValueChange={(value) =>
                  setPreferences({ ...preferences, grouping: value as Grouping })
                }
              >
                <ViewRadioItem value="recent">Recent</ViewRadioItem>
                <ViewRadioItem value="project">Project</ViewRadioItem>
              </DropdownMenu.RadioGroup>
              <DropdownMenu.Separator className="ts-menu-separator" />
              <DropdownMenu.CheckboxItem
                className="ts-menu-item ts-radio-item"
                checked={preferences.pullRequests !== "hidden"}
                onCheckedChange={(checked) =>
                  setPreferences({
                    ...preferences,
                    pullRequests: checked === true ? "smart" : "hidden",
                  })
                }
              >
                <span>Show pull requests</span>
                <DropdownMenu.ItemIndicator className="ts-radio-dot" />
              </DropdownMenu.CheckboxItem>
              <DropdownMenu.Separator className="ts-menu-separator" />
              <DropdownMenu.Label className="ts-menu-label">Sort</DropdownMenu.Label>
              <DropdownMenu.RadioGroup
                value={preferences.sort}
                onValueChange={(value) =>
                  setPreferences({ ...preferences, sort: value as Sort })
                }
              >
                <ViewRadioItem value="activity">Recent activity</ViewRadioItem>
                <ViewRadioItem value="created">Recently created</ViewRadioItem>
                <ViewRadioItem value="name">Name A–Z</ViewRadioItem>
              </DropdownMenu.RadioGroup>
              <DropdownMenu.Separator className="ts-menu-separator" />
              <DropdownMenu.Label className="ts-menu-label">Show</DropdownMenu.Label>
              <DropdownMenu.RadioGroup
                value={preferences.filter}
                onValueChange={(value) =>
                  setPreferences({ ...preferences, filter: value as Filter })
                }
              >
                <ViewRadioItem value="all">All threads</ViewRadioItem>
                <ViewRadioItem value="unread">Unread only</ViewRadioItem>
                <ViewRadioItem value="needs-you">Needs you only</ViewRadioItem>
              </DropdownMenu.RadioGroup>
              <DropdownMenu.Separator className="ts-menu-separator" />
              <DropdownMenu.CheckboxItem
                className="ts-menu-item ts-radio-item"
                checked={preferences.showArchived}
                onCheckedChange={(checked) =>
                  setPreferences({
                    ...preferences,
                    showArchived: checked === true,
                  })
                }
              >
                <span>Archived threads</span>
                <DropdownMenu.ItemIndicator className="ts-radio-dot" />
              </DropdownMenu.CheckboxItem>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <NewProjectDialog
        open={newProjectOpen}
        onOpenChange={setNewProjectOpen}
        onCreated={(projectId) => openNewThread(projectId)}
      />
    </div>
  );
}

function ThreadsSidebar({
  activeThreadId,
  activeProjectId,
  onNavigate,
  searchQuery,
}: PluginThreadListProps) {
  const state = experimental_useSidebarThreads();
  const providersState = experimental_useProviders();
  const settings = useSettings();
  const [preferences, setPreferences] = useStoredState<ViewPreferences>(
    PREFS_KEY,
    DEFAULT_VIEW_PREFERENCES,
  );
  const [collapsed, setCollapsed] = useStoredState<string[]>(COLLAPSE_KEY, []);
  const [expandedParents, setExpandedParents] = useStoredState<string[]>(
    EXPANDED_KEY,
    [],
  );
  const [pullRequests, setPullRequests] = useState<
    Record<string, PluginSidebarPullRequest | null>
  >({});
  const viewPreferences: ViewPreferences = {
    ...DEFAULT_VIEW_PREFERENCES,
    ...preferences,
  };

  const setting = (name: string, fallback: boolean) => {
    const value = settings.values?.[name];
    return typeof value === "boolean" ? value : fallback;
  };
  const sectionConfig = {
    showPinnedSection: setting("showPinnedSection", true),
    showAttentionSection: setting("showAttentionSection", true),
    attentionIncludesUnread: setting("attentionIncludesUnread", true),
    showPrSection:
      setting("showPrSection", true) &&
      viewPreferences.pullRequests !== "hidden",
    showRunningSection: setting("showRunningSection", true),
  };
  const showPrBadges =
    setting("showPrBadges", true) &&
    viewPreferences.pullRequests !== "hidden";
  const showProviderHarness = setting("showProviderHarness", true);

  const providers = new Map(
    providersState.providers.map((provider) => [provider.id, provider]),
  );
  const prIds = useMemo(
    () =>
      new Set(
        Object.entries(pullRequests)
          .filter(([, pullRequest]) => pullRequest !== null)
          .map(([threadId]) => threadId),
      ),
    [pullRequests],
  );
  const sections = organizeThreads({
    threads: state.threads,
    projects: state.projects,
    preferences: { ...viewPreferences, projectId: "all" },
    config: sectionConfig,
    pullRequestThreadIds: prIds,
    searchQuery,
  });
  const byId = new Map(state.threads.map((thread) => [thread.id, thread]));
  const childrenById = new Map<string, PluginSidebarThread[]>();
  for (const thread of state.threads) {
    if (!thread.parentThreadId) continue;
    const children = childrenById.get(thread.parentThreadId) ?? [];
    children.push(thread);
    childrenById.set(thread.parentThreadId, children);
  }
  const rowStatusFor = (thread: PluginSidebarThread): RowStatus => {
    const own: RowStatus = thread.hasPendingInteraction
      ? "attention"
      : thread.isUnread
        ? "unread"
        : isRunning(thread)
          ? "working"
          : null;
    const childStatuses = (childrenById.get(thread.id) ?? []).map(rowStatusFor);
    const statuses = [own, ...childStatuses];
    if (statuses.includes("attention")) return "attention";
    if (statuses.includes("unread")) return "unread";
    if (statuses.includes("working")) return "working";
    return null;
  };
  const expanded = new Set(expandedParents);
  const isRowVisible = (row: OrganizedRow) => {
    let parentId = row.thread.parentThreadId;
    while (parentId && byId.has(parentId)) {
      if (!expanded.has(parentId) && row.thread.id !== activeThreadId) return false;
      parentId = byId.get(parentId)?.parentThreadId ?? null;
    }
    return true;
  };
  const updatePr = useMemo(
    () => (threadId: string, pullRequest: PluginSidebarPullRequest | null) => {
      setPullRequests((current) =>
        current[threadId]?.number === pullRequest?.number &&
        current[threadId]?.state === pullRequest?.state
          ? current
          : { ...current, [threadId]: pullRequest },
      );
    },
    [],
  );
  if (state.status === "loading")
    return <div className="ts-state">Loading threads…</div>;
  if (state.status === "error")
    return <div className="ts-state text-destructive">Couldn’t load threads.</div>;

  return (
    <div className="ts-shell">
      {sectionConfig.showPrSection || showPrBadges
        ? state.threads.map((thread) => (
            <PullRequestProbe
              key={thread.id}
              threadId={thread.id}
              onChange={updatePr}
            />
          ))
        : null}
      <ThreadsHeader
        activeProjectId={activeProjectId}
        projects={state.projects}
        preferences={viewPreferences}
        setPreferences={setPreferences}
        onNavigate={onNavigate}
      />
      <div className="ts-sections">
        {sections.length === 0 ? (
          <div className="ts-state">No matching threads.</div>
        ) : (
          sections.map((section) => {
            const isCollapsed = collapsed.includes(section.id);
            return (
              <section key={section.id} className="ts-section">
                <button
                  className="ts-section-header"
                  data-tone={section.tone}
                  onClick={() =>
                    setCollapsed(
                      isCollapsed
                        ? collapsed.filter((id) => id !== section.id)
                        : [...collapsed, section.id],
                    )
                  }
                >
                  <Icon
                    name={isCollapsed ? "ChevronRight" : "ChevronDown"}
                    className="size-3"
                  />
                  <span>{section.title}</span>
                  {section.showCount ? (
                    <span className="ts-count">{section.rows.length}</span>
                  ) : null}
                </button>
                {!isCollapsed
                  ? section.rows.filter(isRowVisible).map((row) => {
                      const subgroupCollapseId = row.subgroupId
                        ? `subgroup:${section.id}:${row.subgroupId}`
                        : null;
                      const subgroupCollapsed = subgroupCollapseId
                        ? collapsed.includes(subgroupCollapseId)
                        : false;
                      return (
                        <Fragment key={row.thread.id}>
                          {row.subgroupTitle && subgroupCollapseId ? (
                            <button
                              className="ts-subgroup"
                              aria-expanded={!subgroupCollapsed}
                              onClick={() =>
                                setCollapsed(
                                  subgroupCollapsed
                                    ? collapsed.filter(
                                        (id) => id !== subgroupCollapseId,
                                      )
                                    : [...collapsed, subgroupCollapseId],
                                )
                              }
                            >
                              <Icon
                                name={
                                  subgroupCollapsed
                                    ? "ChevronRight"
                                    : "ChevronDown"
                                }
                                className="size-3"
                              />
                              <span>{row.subgroupTitle}</span>
                            </button>
                          ) : null}
                          {!subgroupCollapsed ? (
                            <ThreadRow
                        row={row}
                        active={row.thread.id === activeThreadId}
                        providerName={
                          providers.get(row.thread.providerId)?.displayName ??
                          row.thread.providerId
                        }
                        providerLogoUrl={
                          providers.get(row.thread.providerId)?.logoUrl ?? null
                        }
                        rowStatus={rowStatusFor(row.thread)}
                        showPrBadge={showPrBadges}
                        showProviderHarness={showProviderHarness}
                        expanded={expanded.has(row.thread.id)}
                        setExpanded={(next) =>
                          setExpandedParents(
                            next
                              ? [...expandedParents, row.thread.id]
                              : expandedParents.filter((id) => id !== row.thread.id),
                          )
                        }
                        onNavigate={onNavigate}
                            />
                          ) : null}
                        </Fragment>
                      );
                    })
                  : null}
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "threads-sidebar",
    title: "Threads Sidebar",
    description:
      "Organize threads by recency or project with attention, PR, and running sections.",
    component: ThreadsSidebar,
  });
});
