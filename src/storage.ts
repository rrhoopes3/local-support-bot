import { validateLibrary } from "./core/library";
import type { Library } from "./core/types";

const KEY = "localsupbot.library.v1";
function readPreviewStore(): unknown {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      "Saved library is not valid JSON. Import a library or restore samples.",
    );
  }
}

export async function readLibrary(): Promise<Library | null> {
  const value =
    typeof chrome !== "undefined" && chrome.storage?.local
      ? (await chrome.storage.local.get(KEY))[KEY]
      : readPreviewStore();
  return value ? validateLibrary(value) : null;
}
export async function saveLibrary(library: Library): Promise<void> {
  const checked = validateLibrary(library);
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({ [KEY]: checked });
  } else localStorage.setItem(KEY, JSON.stringify(checked));
}
