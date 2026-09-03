// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  loadPluginApp,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";

function fixture(): PluginSidebarThread {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Recreate the sidebar",
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
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastReadAt: null,
    latestAttentionAt: 0,
  };
}

describe("Threads Sidebar app", () => {
  it("registers the exclusive thread list and supports inline rename", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.threadLists).toHaveLength(1);

    const slot = renderSlot(
      app.threadLists[0]!,
      {
        activeThreadId: null,
        activeProjectId: "project-1",
        isCompactViewport: false,
        onNavigate: () => {},
        searchQuery: "",
        Original: () => null,
      },
      {
        sidebarThreads: {
          status: "ready",
          threads: [fixture()],
          projects: [
            { id: "project-1", name: "Project", isPersonal: false },
          ],
        },
        providers: {
          status: "ready",
          providers: [],
        },
      },
    );

    const title = await slot.findByText("Recreate the sidebar");
    fireEvent.doubleClick(title);
    const input = await slot.findByLabelText("Thread title");
    fireEvent.change(input, { target: { value: "Polished sidebar" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(slot.inspection.sidebarActionCalls).toContainEqual({
      method: "rename",
      threadId: "thread-1",
      title: "Polished sidebar",
    });
    slot.lifecycle.unmount();
  });
});
