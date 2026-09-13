import { validateLibrary } from "./core/library";
import type { Library } from "./core/types";

const KEY = "localsupbot.library.v1";
export async function readLibrary(): Promise<Library | null> {
  const value =
    typeof chrome !== "undefined" && chrome.storage?.local
      ? (await chrome.storage.local.get(KEY))[KEY]
      : JSON.parse(localStorage.getItem(KEY) || "null");
  return value ? validateLibrary(value) : null;
}
export async function saveLibrary(library: Library): Promise<void> {
  const checked = validateLibrary(library);
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({ [KEY]: checked });
  } else localStorage.setItem(KEY, JSON.stringify(checked));
}
