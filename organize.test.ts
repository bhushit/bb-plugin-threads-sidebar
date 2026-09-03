import { describe, expect, it } from "vitest";
import type {
  PluginSidebarProject,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import {
  DEFAULT_SECTION_CONFIG,
  DEFAULT_VIEW_PREFERENCES,
  organizeThreads,
} from "./organize";

const projects: PluginSidebarProject[] = [
  { id: "work", name: "Work", isPersonal: false },
  { id: "personal", name: "Personal", isPersonal: true },
];

function thread(
  id: string,
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id,
    projectId: "work",
    title: id,
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: Date.UTC(2026, 7, 30, 12),
    updatedAt: Date.UTC(2026, 7, 30, 12),
    lastReadAt: null,
    latestAttentionAt: 0,
    ...overrides,
  };
}

describe("organizeThreads", () => {
  it("keeps Attention and PR additive while Pinned stays out of the main list", () => {
    const busyUnreadPinned = thread("one", {
      isPinned: true,
      isUnread: true,
      hasPendingInteraction: true,
      activity: {
        workflows: 1,
        backgroundAgents: 0,
        backgroundCommands: 0,
        planMode: 0,
        goals: 0,
      },
    });
    const sections = organizeThreads({
      threads: [busyUnreadPinned],
      projects,
      preferences: DEFAULT_VIEW_PREFERENCES,
      config: DEFAULT_SECTION_CONFIG,
      pullRequestThreadIds: new Set(["one"]),
      now: Date.UTC(2026, 7, 30, 13),
    });
    expect(sections.map((section) => section.id)).toEqual([
      "pinned",
      "attention",
      "pull-requests",
      "running",
    ]);
    expect(
      sections.map((section) => section.rows.map((row) => row.thread.id)),
    ).toEqual([["one"], ["one"], ["one"], ["one"]]);
  });

  it("puts pending and running threads into quiet top sections", () => {
    const sections = organizeThreads({
      threads: [
        thread("answer", { hasPendingInteraction: true }),
        thread("agent", {
          activity: {
            workflows: 0,
            backgroundAgents: 1,
            backgroundCommands: 0,
            planMode: 0,
            goals: 0,
          },
        }),
      ],
      projects,
      preferences: DEFAULT_VIEW_PREFERENCES,
      config: DEFAULT_SECTION_CONFIG,
      pullRequestThreadIds: new Set(),
      now: Date.UTC(2026, 7, 30, 13),
    });
    expect(sections.map(({ id, tone }) => [id, tone])).toEqual([
      ["attention", "attention"],
      ["running", "running"],
      ["today", undefined],
    ]);
    expect(sections.at(-1)?.rows.map((row) => row.thread.id)).toEqual([
      "answer",
      "agent",
    ]);
  });

  it("treats the host runtime indicator as Running without activity counters", () => {
    const sections = organizeThreads({
      threads: [thread("current", { indicator: "runtime" })],
      projects,
      preferences: DEFAULT_VIEW_PREFERENCES,
      config: DEFAULT_SECTION_CONFIG,
      pullRequestThreadIds: new Set(),
      now: Date.UTC(2026, 7, 30, 13),
    });
    expect(sections.map((section) => section.id)).toEqual([
      "running",
      "today",
    ]);
  });

  it("keeps child threads nested under their parent", () => {
    const sections = organizeThreads({
      threads: [
        thread("parent"),
        thread("child", {
          parentThreadId: "parent",
          originKind: "fork",
        }),
      ],
      projects,
      preferences: DEFAULT_VIEW_PREFERENCES,
      config: DEFAULT_SECTION_CONFIG,
      pullRequestThreadIds: new Set(),
      now: Date.UTC(2026, 7, 30, 13),
    });
    expect(sections[0]?.rows.map(({ thread: item, depth }) => [item.id, depth]))
      .toEqual([
        ["parent", 0],
        ["child", 1],
      ]);
    expect(sections[0]?.rows[0]?.childCount).toBe(1);
  });

  it("orders Personal first when grouping by project", () => {
    const sections = organizeThreads({
      threads: [
        thread("work-thread"),
        thread("personal-thread", { projectId: "personal" }),
      ],
      projects,
      preferences: { ...DEFAULT_VIEW_PREFERENCES, grouping: "project" },
      config: DEFAULT_SECTION_CONFIG,
      pullRequestThreadIds: new Set(),
      now: Date.UTC(2026, 7, 30, 13),
    });
    expect(sections.map((section) => section.title)).toEqual([
      "Personal",
      "Work",
    ]);
  });

  it("orders projects in a time bucket by their newest thread, not personal status", () => {
    const sections = organizeThreads({
      threads: [
        thread("work-thread", { updatedAt: Date.UTC(2026, 7, 30, 10) }),
        thread("personal-thread", {
          projectId: "personal",
          updatedAt: Date.UTC(2026, 7, 30, 12),
        }),
      ],
      projects,
      preferences: DEFAULT_VIEW_PREFERENCES,
      config: DEFAULT_SECTION_CONFIG,
      pullRequestThreadIds: new Set(),
      now: Date.UTC(2026, 7, 30, 13),
    });
    expect(sections).toHaveLength(1);
    // Personal has the most recent thread, so its project group sits on top
    // even though it is a personal project.
    expect(
      sections[0]?.rows.map((row) => [row.thread.id, row.subgroupTitle]),
    ).toEqual([
      ["personal-thread", "Personal"],
      ["work-thread", "Work"],
    ]);
  });

  it("orders recent project groups by their newest thread activity", () => {
    const moreProjects: PluginSidebarProject[] = [
      { id: "alpha", name: "Alpha", isPersonal: false },
      { id: "zulu", name: "Zulu", isPersonal: false },
    ];
    const sections = organizeThreads({
      threads: [
        thread("older-alpha", {
          projectId: "alpha",
          updatedAt: Date.UTC(2026, 7, 30, 10),
        }),
        thread("newer-zulu", {
          projectId: "zulu",
          updatedAt: Date.UTC(2026, 7, 30, 12),
        }),
      ],
      projects: moreProjects,
      preferences: DEFAULT_VIEW_PREFERENCES,
      config: DEFAULT_SECTION_CONFIG,
      pullRequestThreadIds: new Set(),
      now: Date.UTC(2026, 7, 30, 13),
    });
    expect(
      sections[0]?.rows.map((row) => [row.thread.id, row.subgroupTitle]),
    ).toEqual([
      ["newer-zulu", "Zulu"],
      ["older-alpha", "Alpha"],
    ]);
  });

  it("orders project groups alphabetically only for Name A-Z", () => {
    const moreProjects: PluginSidebarProject[] = [
      { id: "alpha", name: "Alpha", isPersonal: false },
      { id: "zulu", name: "Zulu", isPersonal: false },
    ];
    const sections = organizeThreads({
      threads: [
        thread("alpha-thread", { projectId: "alpha" }),
        thread("zulu-thread", { projectId: "zulu" }),
      ],
      projects: moreProjects,
      preferences: { ...DEFAULT_VIEW_PREFERENCES, sort: "name" },
      config: DEFAULT_SECTION_CONFIG,
      pullRequestThreadIds: new Set(),
      now: Date.UTC(2026, 7, 30, 13),
    });
    expect(sections[0]?.rows.map((row) => row.subgroupTitle)).toEqual([
      "Alpha",
      "Zulu",
    ]);
  });

  it("filters archived and search views client-side", () => {
    const sections = organizeThreads({
      threads: [
        thread("active", { title: "Fix checkout" }),
        thread("archived", {
          title: "Old checkout spike",
          isArchived: true,
        }),
      ],
      projects,
      preferences: {
        ...DEFAULT_VIEW_PREFERENCES,
        showArchived: true,
      },
      config: DEFAULT_SECTION_CONFIG,
      pullRequestThreadIds: new Set(),
      searchQuery: "checkout",
      now: Date.UTC(2026, 7, 30, 13),
    });
    expect(sections.flatMap((section) => section.rows).map((row) => row.thread.id))
      .toEqual(["archived"]);
  });
});
