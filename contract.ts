import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const threadsSidebarRpcContract = defineRpcContract({
  listProjectHosts: {
    input: z.null(),
    output: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          status: z.enum(["connected", "disconnected"]),
        })
        .strict(),
    ),
  },
  browseHostDirectory: {
    input: z
      .object({
        hostId: z.string().trim().min(1),
        path: z.string().nullable(),
      })
      .strict(),
    output: z
      .object({
        directory: z.string(),
        parent: z.string().nullable(),
        entries: z.array(
          z
            .object({
              kind: z.enum(["directory", "file"]),
              name: z.string(),
              path: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  createHostFolder: {
    input: z
      .object({
        hostId: z.string().trim().min(1),
        path: z.string().trim().min(1),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  createProject: {
    input: z
      .object({
        hostId: z.string().trim().min(1),
        path: z.string().trim().min(1),
        name: z.string().trim().optional(),
      })
      .strict(),
    output: z.object({ projectId: z.string(), name: z.string() }).strict(),
  },
  renameWithAi: {
    input: z.object({ threadId: z.string().trim().min(1) }).strict(),
    output: z.object({ title: z.string().trim().min(1) }).strict(),
  },
});
