import { describe, expect, it } from "vitest";
import { RELOAD_TAB, sendToWorker } from "../src/shared/messaging";
import type { AssessRequestMessage } from "../src/shared/types";

const withSend = (fn: () => Promise<unknown>) => {
  (globalThis as unknown as { chrome: unknown }).chrome = { runtime: { sendMessage: fn } };
};
const msg: AssessRequestMessage = { type: "assess", post: {} as never, comments: [], cards: [] };

describe("sendToWorker", () => {
  it("passes a normal reply through", async () => {
    withSend(async () => ({ ok: true, cached: true, verdict: {} }));
    await expect(sendToWorker(msg)).resolves.toMatchObject({ ok: true });
  });

  it.each(["Extension context invalidated.", "Could not establish connection. Receiving end does not exist."])(
    "turns '%s' into a non-retryable reload hint",
    async (text) => {
      withSend(async () => {
        throw new Error(text);
      });
      await expect(sendToWorker(msg)).resolves.toEqual({ ok: false, error: RELOAD_TAB, retryable: false });
    },
  );

  it("treats other failures and empty replies as retryable", async () => {
    withSend(async () => {
      throw new Error("boom");
    });
    await expect(sendToWorker(msg)).resolves.toMatchObject({ ok: false, retryable: true });
    withSend(async () => undefined);
    await expect(sendToWorker(msg)).resolves.toMatchObject({ ok: false, retryable: true });
  });
});
