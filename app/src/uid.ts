export function normalizeUid(value: string): string | null {
  const uid = value.trim().toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(uid) || !uid.startsWith("E00403")) {
    return null;
  }
  return uid;
}

export function reverseUid(value: string): string | null {
  const uid = normalizeUid(value);
  if (!uid) {
    return null;
  }
  let reversed = "";
  for (let index = uid.length - 2; index >= 0; index -= 2) {
    reversed += uid.slice(index, index + 2);
  }
  return reversed;
}

export function contentPath(contentDir: string, uid: string): string | null {
  const reversed = reverseUid(uid);
  if (!reversed || !contentDir) {
    return null;
  }
  const separator = contentDir.includes("\\") ? "\\" : "/";
  const root = contentDir.replace(/[\\/]+$/, "");
  return `${root}${separator}${reversed.slice(0, 8)}${separator}${reversed.slice(8)}`;
}

export function fileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}
