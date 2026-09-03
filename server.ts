import type { BbPluginApi } from "@get-bb/plugin-sdk";
import path from "node:path";
import { threadsSidebarRpcContract } from "./contract.js";

const DEFAULT_TITLE_MODEL = "codex:gpt-5.6-luna";
const AUTO_TITLE_MESSAGE_COUNT = 2;
const TITLE_TIMEOUT_MS = 120_000;

type ThreadForTitle = {
  id: string;
  projectId: string;
  environmentId: string | null;
};

export function parseModel(value: string): { providerId: string; model: string } {
  const normalized = value.trim();
  const separator = normalized.indexOf(":");
  if (separator === -1) {
    return { providerId: "codex", model: normalized || "gpt-5.6-luna" };
  }
  const providerId = normalized.slice(0, separator).trim();
  const model = normalized.slice(separator + 1).trim();
  return {
    providerId: providerId || "codex",
    model: model || "gpt-5.6-luna",
  };
}

export function cleanGeneratedTitle(output: string | null): string | null {
  if (output === null) return null;
  const line = output
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return null;
  let cleaned = line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^(?:title\s*:\s*)/i, "")
    .replace(/^[`"'“”]+|[`"'“”]+$/g, "")
    .replace(/[.]+$/, "")
    .trim();
  if (!cleaned) return null;
  const words = cleaned.split(/\s+/);
  if (words.length > 6) cleaned = words.slice(0, 6).join(" ");
  return cleaned.length > 48
    ? `${cleaned.slice(0, 45).trimEnd()}…`
    : cleaned;
}

function titlePrompt(
  messages: readonly { role: "assistant" | "user"; preview: string }[],
): string {
  const firstUserRequest = messages.find(
    (message) => message.role === "user",
  )?.preview;
  // Use the whole-thread synopsis (conversationOutline already truncates each
  // message to a preview). For very long threads keep the start and end so the
  // overall arc survives without an unbounded prompt.
  const synopsisItems =
    messages.length > 40
      ? [...messages.slice(0, 20), ...messages.slice(-20)]
      : messages;
  const synopsis = synopsisItems
    .map((message) => `${message.role.toUpperCase()}: ${message.preview}`)
    .join("\n");
  return [
    "Title this coding-agent conversation for a compact sidebar list.",
    "You are given the user's first request and a synopsis of the whole conversation (each message is already truncated).",
    "Summarize the overall goal — what the user is ultimately trying to accomplish across the entire chat, anchored by their first request. Ignore the latest message and any current status or side-tangents.",
    "Rules:",
    "- At most 5 words. Shorter is better.",
    "- Sentence case, no ending punctuation.",
    "- Name the concrete task, feature, or subject; never generic words like 'help', 'question', or 'discussion'.",
    "- Return only the title: no quotation marks, label, markdown, or explanation.",
    "Do not use tools.",
    "",
    firstUserRequest ? `First request:\n${firstUserRequest}\n` : "",
    "Whole-conversation synopsis:",
    synopsis,
  ].join("\n");
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");
  const titleJobs = new Set<string>();

  const settings = bb.settings.define({
    showPinnedSection: {
      type: "boolean",
      label: "Show Pinned section",
      default: true,
    },
    showAttentionSection: {
      type: "boolean",
      label: "Show Attention section",
      default: true,
    },
    attentionIncludesUnread: {
      type: "boolean",
      label: "Include unread threads in Attention",
      default: true,
    },
    showPrSection: {
      type: "boolean",
      label: "Show Pull Requests section",
      default: true,
    },
    showRunningSection: {
      type: "boolean",
      label: "Show Running section",
      default: true,
    },
    showPrBadges: {
      type: "boolean",
      label: "Show pull request badges",
      default: true,
    },
    showProviderHarness: {
      type: "boolean",
      label: "Show agent icon",
      default: true,
    },
    autoTitleThreads: {
      type: "boolean",
      label: "Automatically title new threads",
      description: "Generate one title after the second user message.",
      default: true,
    },
    autoTitleModel: {
      type: "string",
      label: "Title model",
      description: "Use provider:model. Defaults to Codex GPT-5.6 Luna.",
      default: DEFAULT_TITLE_MODEL,
    },
  });

  const generateAndApplyTitle = async (
    thread: ThreadForTitle,
    modelSetting: string,
  ): Promise<string> => {
    if (titleJobs.has(thread.id)) throw new Error("A title is already being generated");
    titleJobs.add(thread.id);
    let workerId: string | null = null;
    try {
      const outline = await bb.sdk.threads.conversationOutline({
        threadId: thread.id,
      });
      if (outline.items.length === 0) throw new Error("This thread has no messages yet");
      const selection = parseModel(modelSetting);
      const worker = await bb.sdk.threads.spawn({
        projectId: thread.projectId,
        environment: thread.environmentId
          ? { type: "reuse", environmentId: thread.environmentId }
          : { type: "project-default" },
        prompt: titlePrompt(outline.items),
        title: "Generate thread title",
        providerId: selection.providerId,
        model: selection.model,
        reasoningLevel: "low",
        permissionMode: "auto",
        visibility: "hidden",
      });
      workerId = worker.id;
      await bb.sdk.threads.wait({
        threadId: worker.id,
        status: "idle",
        timeoutMs: TITLE_TIMEOUT_MS,
      });
      const result = await bb.sdk.threads.output({ threadId: worker.id });
      const title = cleanGeneratedTitle(result.output);
      if (title === null) throw new Error("The title model returned no usable title");
      await bb.sdk.threads.update({ threadId: thread.id, title });
      return title;
    } finally {
      if (workerId !== null) {
        await bb.sdk.threads.stop({ threadId: workerId }).catch(() => undefined);
        await bb.sdk.threads.archive({ threadId: workerId }).catch(() => undefined);
      }
      titleJobs.delete(thread.id);
    }
  };

  bb.rpc.register(threadsSidebarRpcContract, {
    async listProjectHosts() {
      const hosts = await bb.sdk.hosts.list();
      return hosts.map(({ id, name, status }) => ({ id, name, status }));
    },
    async browseHostDirectory({ hostId, path: directory }) {
      return bb.sdk.hosts.directory({
        hostId,
        ...(directory ? { path: directory } : {}),
      });
    },
    async createHostFolder({ hostId, path: folderPath }) {
      await bb.sdk.files.mkdir({ hostId, path: folderPath });
      return { ok: true as const };
    },
    async createProject({ hostId, path: projectPath, name }) {
      const normalizedPath = projectPath.trim().replace(/\/$/, "");
      const projectName = name?.trim() || path.basename(normalizedPath);
      if (!projectName) throw new Error("Enter a valid project path");
      const project = await bb.sdk.projects.create({
        name: projectName,
        source: { type: "local_path", hostId, path: normalizedPath },
      });
      return { projectId: project.id, name: project.name };
    },
    async renameWithAi({ threadId }) {
      const [thread, config] = await Promise.all([
        bb.sdk.threads.get({ threadId }),
        settings.get(),
      ]);
      const title = await generateAndApplyTitle(thread, config.autoTitleModel);
      await bb.storage.kv.set(`auto-title-complete:${thread.id}`, true);
      return { title };
    },
  });

  bb.events.on("thread.idle", async ({ thread }) => {
    if (thread.originPluginId === bb.pluginId || thread.visibility === "hidden") return;
    const config = await settings.get();
    if (!config.autoTitleThreads) return;
    if (await bb.storage.kv.get<boolean>(`auto-title-complete:${thread.id}`)) return;

    const outline = await bb.sdk.threads.conversationOutline({
      threadId: thread.id,
    });
    const userMessageCount = outline.items.filter(
      (item) => item.role === "user",
    ).length;
    // Allow one extra idle boundary in case the event projection races the
    // conversation outline at exactly the second message. The completion key
    // still guarantees that this can apply only once.
    if (
      userMessageCount < AUTO_TITLE_MESSAGE_COUNT ||
      userMessageCount > AUTO_TITLE_MESSAGE_COUNT + 1
    )
      return;

    try {
      await generateAndApplyTitle(thread, config.autoTitleModel);
      await bb.storage.kv.set(`auto-title-complete:${thread.id}`, true);
      bb.log.info(`automatic title applied to ${thread.id}`);
    } catch (error) {
      bb.log.warn(
        `automatic title failed for ${thread.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  bb.onDispose(() => bb.log.info("disposed"));
}
