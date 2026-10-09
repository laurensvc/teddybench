import { invoke } from "@tauri-apps/api/core";

export type Figure = {
  uid: string;
  path: string;
  audioId: string;
  time: string;
  chapters: number;
};

export type ContentListing = {
  dir: string;
  figures: Figure[];
};

export type UidPreview = {
  uid: string;
  directory: string;
  file: string;
  fullPath: string;
  exists: boolean;
};

export function listDrives(): Promise<string[]> {
  return invoke("list_drives");
}

export function listContent(contentDir: string): Promise<ContentListing> {
  return invoke("list_content", { contentDir });
}

export function previewUid(contentDir: string, uid: string): Promise<UidPreview> {
  return invoke("preview_uid", { contentDir, uid });
}

export function encodeToUid(
  contentDir: string,
  uid: string,
  files: string[],
  bitrate: number,
): Promise<Figure> {
  return invoke("encode_to_uid", { contentDir, uid, files, bitrate });
}

export function moveUid(contentDir: string, fromUid: string, toUid: string): Promise<Figure> {
  return invoke("move_uid", { contentDir, fromUid, toUid });
}

export function deleteContent(contentDir: string, uid: string): Promise<void> {
  return invoke("delete_content", { contentDir, uid });
}

export function exportOgg(toniePath: string, outputDir: string, intoTemp: boolean): Promise<string> {
  return invoke("export_ogg", { toniePath, outputDir, intoTemp });
}
