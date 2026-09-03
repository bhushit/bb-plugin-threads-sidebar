import type {
  PluginSidebarProject,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";

export type Grouping = "recent" | "project";
export type Sort = "activity" | "created" | "name";
export type Filter = "all" | "unread" | "needs-you";
export type PullRequestView = "smart" | "all" | "hidden";

export interface ViewPreferences {
  grouping: Grouping;
  sort: Sort;
  filter: Filter;
  pullRequests: PullRequestView;
  projectId: string;
  showArchived: boolean;
}

export interface SectionConfig {
  showPinnedSection: boolean;
  showAttentionSection: boolean;
  attentionIncludesUnread: boolean;
  showPrSection: boolean;
  showRunningSection: boolean;
}

export interface OrganizedRow {
  thread: PluginSidebarThread;
  depth: number;
  childCount: number;
  /** Project heading inserted before this root inside a compound section. */
  subgroupTitle?: string;
  /** Project id shared by every row under a compound project heading. */
  subgroupId?: string;
}

export interface OrganizedSection {
  id: string;
  title: string;
  tone?: "attention" | "running";
  showCount?: boolean;
  rows: OrganizedRow[];
}

export const DEFAULT_VIEW_PREFERENCES: ViewPreferences = {
  grouping: "recent",
  sort: "activity",
  filter: "all",
  pullRequests: "smart",
  projectId: "all",
  showArchived: false,
};

export const DEFAULT_SECTION_CONFIG: SectionConfig = {
  showPinnedSection: true,
  showAttentionSection: true,
  attentionIncludesUnread: true,
  showPrSection: true,
  showRunningSection: true,
};

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

function titleOf(thread: PluginSidebarThread): string {
  return thread.title ?? thread.titleFallback ?? "Untitled thread";
}

function sorter(sort: Sort) {
  return (a: PluginSidebarThread, b: PluginSidebarThread): number => {
    if (sort === "name") return titleOf(a).localeCompare(titleOf(b));
    if (sort === "created") return b.createdAt - a.createdAt;
    return b.updatedAt - a.updatedAt;
  };
}

function flattenTree(
  roots: PluginSidebarThread[],
  children: Map<string, PluginSidebarThread[]>,
  sort: Sort,
): OrganizedRow[] {
  const compare = sorter(sort);
  const rows: OrganizedRow[] = [];
  const visit = (thread: PluginSidebarThread, depth: number) => {
    const directChildren = [...(children.get(thread.id) ?? [])].sort(compare);
    rows.push({ thread, depth, childCount: directChildren.length });
    for (const child of directChildren) visit(child, depth + 1);
  };
  for (const root of [...roots].sort(compare)) visit(root, 0);
  return rows;
}

function flattenProjectGroups(
  roots: PluginSidebarThread[],
  children: Map<string, PluginSidebarThread[]>,
  projects: readonly PluginSidebarProject[],
  sort: Sort,
  personalFirst: boolean,
): OrganizedRow[] {
  const grouped = new Map<string, PluginSidebarThread[]>();
  for (const root of roots) {
    const group = grouped.get(root.projectId) ?? [];
    group.push(root);
    grouped.set(root.projectId, group);
  }
  const projectMetric = (projectId: string): number => {
    const projectRoots = grouped.get(projectId) ?? [];
    if (projectRoots.length === 0) return 0;
    return Math.max(
      ...projectRoots.map((thread) =>
        sort === "created" ? thread.createdAt : thread.updatedAt,
      ),
    );
  };
  const orderedProjects = [...projects].sort((a, b) => {
    // Personal status is a primary key only when the caller explicitly wants
    // personal projects grouped first (the "group by project" view). In the
    // recency-bucketed view we order projects purely by their most recent
    // thread, so the project with the latest activity always sits on top.
    if (personalFirst) {
      const personalOrder = Number(b.isPersonal) - Number(a.isPersonal);
      if (personalOrder !== 0) return personalOrder;
    }
    if (sort === "name") return a.name.localeCompare(b.name);
    return projectMetric(b.id) - projectMetric(a.id) || a.name.localeCompare(b.name);
  });
  const rows: OrganizedRow[] = [];
  for (const project of orderedProjects) {
    const projectRoots = grouped.get(project.id);
    if (!projectRoots?.length) continue;
    const projectRows = flattenTree(projectRoots, children, sort);
    const first = projectRows[0];
    if (first) first.subgroupTitle = project.name;
    for (const row of projectRows) row.subgroupId = project.id;
    rows.push(...projectRows);
  }
  return rows;
}

function recencyBucket(updatedAt: number, now: number): [string, string] {
  const current = new Date(now);
  const startToday = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate(),
  ).getTime();
  const age = startToday - updatedAt;
  if (updatedAt >= startToday) return ["today", "Today"];
  if (age < 2 * 86_400_000) return ["yesterday", "Yesterday"];
  if (age < 7 * 86_400_000) return ["previous-7", "Previous 7 days"];
  if (age < 30 * 86_400_000) return ["previous-30", "Previous 30 days"];
  return ["older", "Older"];
}

export function organizeThreads({
  threads,
  projects,
  preferences,
  config,
  pullRequestThreadIds,
  searchQuery = "",
  now = Date.now(),
}: {
  threads: readonly PluginSidebarThread[];
  projects: readonly PluginSidebarProject[];
  preferences: ViewPreferences;
  config: SectionConfig;
  pullRequestThreadIds: ReadonlySet<string>;
  searchQuery?: string;
  now?: number;
}): OrganizedSection[] {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const query = searchQuery.trim().toLocaleLowerCase();
  const visible = threads.filter((thread) => {
    if (!preferences.showArchived && thread.isArchived) return false;
    if (preferences.showArchived && !thread.isArchived) return false;
    if (preferences.projectId !== "all" && thread.projectId !== preferences.projectId)
      return false;
    if (preferences.filter === "unread" && !thread.isUnread) return false;
    if (preferences.filter === "needs-you" && !thread.hasPendingInteraction)
      return false;
    if (query) {
      const haystack = [
        titleOf(thread),
        projectById.get(thread.projectId)?.name,
        thread.environment?.branchName,
        thread.host?.name,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  const byId = new Map(visible.map((thread) => [thread.id, thread]));
  const rootFor = (thread: PluginSidebarThread): PluginSidebarThread => {
    let current = thread;
    const seen = new Set<string>();
    while (
      current.parentThreadId &&
      byId.has(current.parentThreadId) &&
      !seen.has(current.id)
    ) {
      seen.add(current.id);
      current = byId.get(current.parentThreadId)!;
    }
    return current;
  };
  const roots = visible.filter(
    (thread) => !thread.parentThreadId || !byId.has(thread.parentThreadId),
  );
  const children = new Map<string, PluginSidebarThread[]>();
  for (const thread of visible) {
    if (!thread.parentThreadId || !byId.has(thread.parentThreadId)) continue;
    const siblings = children.get(thread.parentThreadId) ?? [];
    siblings.push(thread);
    children.set(thread.parentThreadId, siblings);
  }

  const consumed = new Set<string>();
  const sections: OrganizedSection[] = [];
  const addSection = (
    id: string,
    title: string,
    predicate: (root: PluginSidebarThread) => boolean,
    {
      consume = false,
      additive = false,
      groupedByProject = false,
      showCount = false,
    }: {
      consume?: boolean;
      additive?: boolean;
      groupedByProject?: boolean;
      showCount?: boolean;
    } = {},
    tone?: OrganizedSection["tone"],
  ) => {
    const selected = roots.filter(
      (root) => (additive || !consumed.has(root.id)) && predicate(root),
    );
    if (selected.length === 0) return;
    if (consume) for (const root of selected) consumed.add(root.id);
    sections.push({
      id,
      title,
      tone,
      showCount,
      rows: groupedByProject
        ? flattenProjectGroups(
            selected,
            children,
            projects,
            preferences.sort,
            false,
          )
        : flattenTree(selected, children, preferences.sort),
    });
  };

  if (config.showPinnedSection)
    addSection("pinned", "Pinned", (root) => root.isPinned, { consume: true });
  if (config.showAttentionSection)
    addSection(
      "attention",
      "Attention",
      (root) =>
        root.hasPendingInteraction ||
        (config.attentionIncludesUnread && root.isUnread) ||
        visible.some(
          (thread) =>
            rootFor(thread).id === root.id &&
            (thread.hasPendingInteraction ||
              (config.attentionIncludesUnread && thread.isUnread)),
        ),
      { additive: true, groupedByProject: true, showCount: true },
      "attention",
    );
  if (config.showPrSection)
    addSection(
      "pull-requests",
      "Pull Requests",
      (root) =>
        pullRequestThreadIds.has(root.id) ||
        visible.some(
          (thread) =>
            rootFor(thread).id === root.id && pullRequestThreadIds.has(thread.id),
        ),
      { additive: true },
    );
  if (config.showRunningSection)
    addSection(
      "running",
      "Running",
      (root) =>
        isRunning(root) ||
        visible.some(
          (thread) => rootFor(thread).id === root.id && isRunning(thread),
        ),
      { additive: true, showCount: true },
      "running",
    );

  const remaining = roots.filter((root) => !consumed.has(root.id));
  if (preferences.grouping === "project") {
    const groupedRows = flattenProjectGroups(
      remaining,
      children,
      projects,
      preferences.sort,
      true,
    );
    for (const row of groupedRows) {
      if (!row.subgroupTitle) continue;
      const start = groupedRows.indexOf(row);
      const next = groupedRows.findIndex(
        (candidate, index) => index > start && candidate.subgroupTitle,
      );
      sections.push({
        id: `project:${row.thread.projectId}`,
        title: row.subgroupTitle,
        rows: groupedRows
          .slice(start, next === -1 ? undefined : next)
          .map((candidate) => ({
            ...candidate,
            subgroupTitle: undefined,
            subgroupId: undefined,
          })),
      });
    }
  } else {
    const buckets = new Map<
      string,
      { title: string; roots: PluginSidebarThread[] }
    >();
    for (const root of remaining) {
      const [id, title] = recencyBucket(root.updatedAt, now);
      const bucket = buckets.get(id) ?? { title, roots: [] };
      bucket.roots.push(root);
      buckets.set(id, bucket);
    }
    for (const id of ["today", "yesterday", "previous-7", "previous-30", "older"]) {
      const bucket = buckets.get(id);
      if (!bucket?.roots.length) continue;
      sections.push({
        id,
        title: bucket.title,
        rows: flattenProjectGroups(
          bucket.roots,
          children,
          projects,
          preferences.sort,
          false,
        ),
      });
    }
  }
  return sections;
}
