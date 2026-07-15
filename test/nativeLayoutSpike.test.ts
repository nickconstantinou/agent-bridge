import { describe, expect, it } from "vitest";
import {
  buildNativeLayoutPayload,
  buildNativePhotoPayload,
  countCodeBlocks,
  routeNativeLayout,
} from "../scripts/native-layout-spike.js";

describe("native layout spike helpers", () => {
  it("routes long or code-block-heavy responses to in-memory documents", () => {
    expect(routeNativeLayout("x".repeat(3_501)).kind).toBe("document");
    expect(routeNativeLayout("```a```\n```b```\n```c```\n```d```").kind).toBe("document");
    expect(routeNativeLayout("| A | B |\n|---|---|\n| 1 | 2 |").kind).toBe("message");
    expect(countCodeBlocks("```a```\nplain\n```b```")).toBe(2);
  });

  it("builds a response.md document payload from memory only", async () => {
    const payload = buildNativeLayoutPayload("x".repeat(3_501), "123");

    expect(payload.method).toBe("sendDocument");
    expect(payload.body).toBeInstanceOf(FormData);
    const file = (payload.body as FormData).get("document") as File;
    expect(file.name).toBe("response.md");
    expect(file.type).toBe("text/markdown");
    expect(file.size).toBe(Buffer.byteLength("x".repeat(3_501)));
  });

  it("builds an in-memory photo payload without requiring a temp file path", async () => {
    const payload = buildNativePhotoPayload(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "123");

    expect(payload.method).toBe("sendPhoto");
    const file = (payload.body as FormData).get("photo") as File;
    expect(file.name).toBe("response.png");
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(4);
  });

});
