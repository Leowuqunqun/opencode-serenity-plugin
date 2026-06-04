import { describe, it, expect } from "vitest";
import plugin from "../src/index";

describe("plugin stub", () => {
  it("exports a default async function", () => {
    expect(typeof plugin).toBe("function");
  });

  it("returns an empty object on call", async () => {
    const result = await plugin();
    expect(result).toEqual({});
  });
});
