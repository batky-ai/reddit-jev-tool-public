import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Resolved from the project root: under the jsdom environment import.meta.url
// is not a file: URL, so relative URL loading fails.
export const fixture = (name: string): string =>
  readFileSync(resolve(process.cwd(), "test/fixtures", name), "utf8");
