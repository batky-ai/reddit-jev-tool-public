// The one way content scripts talk to the service worker. sendMessage throws
// ("Extension context invalidated") when the extension is reloaded while a
// Reddit tab stays open; unguarded, that left previews stuck on "Checking" and
// thread scanning silently stopped. Every failure becomes a normal error result.

import type { AssessRequestMessage, AssessResponse, ScoreRequestMessage, ScoreResponse } from "./types";

export const RELOAD_TAB = "The extension was updated. Reload this tab.";

function toError(e: unknown): { ok: false; error: string; retryable: boolean } {
  const message = String((e as Error)?.message ?? e);
  // Only a dead extension context means "reload the tab". A closed message port
  // can also be a normal service-worker restart, which is worth retrying.
  if (/Extension context invalidated|Receiving end does not exist/i.test(message)) {
    return { ok: false, error: RELOAD_TAB, retryable: false };
  }
  return { ok: false, error: message, retryable: true };
}

export async function sendToWorker(msg: ScoreRequestMessage): Promise<ScoreResponse>;
export async function sendToWorker(msg: AssessRequestMessage): Promise<AssessResponse>;
export async function sendToWorker(msg: ScoreRequestMessage | AssessRequestMessage): Promise<ScoreResponse | AssessResponse> {
  try {
    const res = (await chrome.runtime.sendMessage(msg)) as ScoreResponse | AssessResponse | undefined;
    return res ?? { ok: false, error: "No response from the extension", retryable: true };
  } catch (e) {
    return toError(e);
  }
}
