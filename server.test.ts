import { describe, expect, it } from "vitest";
import { cleanGeneratedTitle, parseModel } from "./server";

describe("AI title helpers", () => {
  it("defaults bare model names to Codex", () => {
    expect(parseModel("gpt-5.6-luna")).toEqual({
      providerId: "codex",
      model: "gpt-5.6-luna",
    });
    expect(parseModel("codex:gpt-5.6-luna")).toEqual({
      providerId: "codex",
      model: "gpt-5.6-luna",
    });
  });

  it("normalizes a title-only model response", () => {
    expect(cleanGeneratedTitle('Title: "Rebuild the threads sidebar"')).toBe(
      "Rebuild the threads sidebar",
    );
    expect(cleanGeneratedTitle("\n\n")).toBeNull();
  });
});
