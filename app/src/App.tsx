import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { load, type Store } from "@tauri-apps/plugin-store";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteContent,
  encodeToUid,
  exportOgg,
  listContent,
  listDrives,
  moveUid,
  previewUid,
  type Figure,
  type UidPreview,
} from "./api";
import { contentPath, fileName, normalizeUid } from "./uid";
import "./App.css";

type Composer = {
  tracks: string[];
  destination: string;
  newUid: string;
  bitrate: number;
  confirming: boolean;
};

function figureLabel(figure: Figure, nicknames: Record<string, string>): string {
  const name = nicknames[figure.uid]?.trim();
  return name || figure.uid;
}

function chapterLabel(count: number): string {
  if (count === 1) {
    return "1 chapter";
  }
  return `${count} chapters`;
}

function App() {
  const storeRef = useRef<Store | null>(null);
  const contentDirRef = useRef<string | null>(null);
  const [contentDir, setContentDir] = useState<string | null>(null);
  const [drives, setDrives] = useState<string[]>([]);
  const [figures, setFigures] = useState<Figure[]>([]);
  const [nicknames, setNicknames] = useState<Record<string, string>>({});
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [preview, setPreview] = useState<UidPreview | null>(null);
  const [log, setLog] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [renameUid, setRenameUid] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [changeUid, setChangeUid] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [player, setPlayer] = useState<{ title: string; src: string } | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropUid, setDropUid] = useState<string | null>(null);

  const selected = figures.find((figure) => figure.uid === selectedUid) ?? null;
  contentDirRef.current = contentDir;

  const refresh = useCallback(async (dir: string) => {
    const listing = await listContent(dir);
    setContentDir(listing.dir);
    setFigures(listing.figures);
    setSelectedUid((current) =>
      listing.figures.some((figure) => figure.uid === current) ? current : null,
    );
    if (storeRef.current) {
      await storeRef.current.set("contentDir", listing.dir);
      await storeRef.current.save();
    }
    return listing;
  }, []);

  const openComposer = useCallback((tracks: string[], destination = "") => {
    setBanner(null);
    setConfirmDelete(false);
    setLog("");
    setComposer({
      tracks,
      destination,
      newUid: "",
      bitrate: 96,
      confirming: false,
    });
  }, []);

  useEffect(() => {
    let alive = true;
    let stopDrop: (() => void) | undefined;
    const stopLog = listen<string>("teddy://log", (event) => {
      setLog(event.payload);
    });

    void (async () => {
      try {
        const store = await load("settings.json", { autoSave: false, defaults: {} });
        if (!alive) {
          return;
        }
        storeRef.current = store;
        const savedNames = await store.get<Record<string, string>>("nicknames");
        const savedDir = await store.get<string>("contentDir");
        if (savedNames) {
          setNicknames(savedNames);
        }
        const found = await listDrives();
        if (!alive) {
          return;
        }
        setDrives(found);
        if (savedDir) {
          await refresh(savedDir);
        }
      } catch (error) {
        if (alive) {
          setBanner(error instanceof Error ? error.message : String(error));
        }
      }
      if (!alive) {
        return;
      }

      try {
        stopDrop = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "leave") {
            setDropUid(null);
            return;
          }
          const position = event.payload.position;
          const element = document.elementFromPoint(
            position.x / window.devicePixelRatio,
            position.y / window.devicePixelRatio,
          );
          const uid = element?.closest<HTMLElement>("[data-uid]")?.dataset.uid ?? null;
          if (event.payload.type !== "drop") {
            setDropUid(uid);
            return;
          }
          setDropUid(null);
          const audio = event.payload.paths.filter((path) => /\.(mp3|ogg)$/i.test(path));
          if (audio.length === 0) {
            setBanner("Drop MP3 or Ogg files.");
            return;
          }
          if (!contentDirRef.current) {
            setBanner("Open the CONTENT folder on the SD card first.");
            return;
          }
          openComposer(audio, uid ?? "");
        });
      } catch {
        // The window is not a Tauri webview.
      }
    })();

    return () => {
      alive = false;
      stopDrop?.();
      void stopLog.then((stop) => stop());
    };
  }, [openComposer, refresh]);

  useEffect(() => {
    if (!composer || !contentDir) {
      setPreview(null);
      return;
    }
    const uid = composer.destination || composer.newUid;
    if (!normalizeUid(uid)) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    void previewUid(contentDir, uid)
      .then((value) => {
        if (!cancelled) {
          setPreview(value);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreview(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [composer, contentDir]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && composer && !busy) {
        if (composer.confirming) {
          setComposer({ ...composer, confirming: false });
        } else {
          setComposer(null);
          setPlayer(null);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [composer, busy]);

  async function chooseFolder() {
    const picked = await open({ directory: true, multiple: false, title: "CONTENT folder" });
    if (typeof picked !== "string") {
      return;
    }
    setBanner(null);
    try {
      await refresh(picked);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error));
    }
  }

  async function addAudio() {
    if (!contentDir) {
      setBanner("Open the CONTENT folder on the SD card first.");
      return;
    }
    const picked = await open({
      multiple: true,
      title: "Audio files",
      filters: [{ name: "Audio", extensions: ["mp3", "ogg"] }],
    });
    if (!picked) {
      return;
    }
    const tracks = Array.isArray(picked) ? picked : [picked];
    openComposer(tracks, selectedUid ?? "");
  }

  async function saveNicknames(next: Record<string, string>) {
    setNicknames(next);
    if (storeRef.current) {
      await storeRef.current.set("nicknames", next);
      await storeRef.current.save();
    }
  }

  function commitRename() {
    if (!renameUid) {
      return;
    }
    const next = { ...nicknames };
    const trimmed = renameValue.trim();
    if (trimmed) {
      next[renameUid] = trimmed;
    } else {
      delete next[renameUid];
    }
    void saveNicknames(next);
    setRenameUid(null);
  }

  const destinationUid = composer?.destination || normalizeUid(composer?.newUid ?? "") || "";
  const destinationFigure = figures.find((figure) => figure.uid === destinationUid) ?? null;
  const destinationName = destinationFigure
    ? figureLabel(destinationFigure, nicknames)
    : destinationUid;
  const localPath = contentDir && destinationUid ? contentPath(contentDir, destinationUid) : null;
  const replacing = preview?.exists ?? destinationFigure != null;

  async function writeAudio() {
    if (!composer || !contentDir || !destinationUid) {
      return;
    }
    if (replacing && !composer.confirming) {
      setComposer({ ...composer, confirming: true });
      return;
    }
    setBusy(destinationUid);
    setBanner(null);
    setLog("");
    try {
      await encodeToUid(contentDir, destinationUid, composer.tracks, composer.bitrate);
      await refresh(contentDir);
      setSelectedUid(destinationUid);
      setComposer(null);
      setPlayer(null);
    } catch (error) {
      setBanner(null);
      setLog(error instanceof Error ? error.message : String(error));
      setComposer({ ...composer, confirming: false });
    } finally {
      setBusy(null);
    }
  }

  async function applyChangeUid() {
    if (!selected || !contentDir) {
      return;
    }
    const next = normalizeUid(changeUid);
    if (!next) {
      setBanner("Enter a 16-character hex UID starting with E00403.");
      return;
    }
    setBusy(selected.uid);
    setBanner(null);
    try {
      await moveUid(contentDir, selected.uid, next);
      const names = { ...nicknames };
      if (names[selected.uid]) {
        names[next] = names[selected.uid];
        delete names[selected.uid];
        await saveNicknames(names);
      }
      await refresh(contentDir);
      setSelectedUid(next);
      setChangeUid("");
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function removeSelected() {
    if (!selected || !contentDir) {
      return;
    }
    setBusy(selected.uid);
    setBanner(null);
    try {
      await deleteContent(contentDir, selected.uid);
      await refresh(contentDir);
      setConfirmDelete(false);
      setPlayer(null);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function listenTo(figure: Figure) {
    setBusy(figure.uid);
    setBanner(null);
    setLog("");
    try {
      const path = await exportOgg(figure.path, "", true);
      setPlayer({ title: figureLabel(figure, nicknames), src: convertFileSrc(path) });
    } catch (error) {
      setLog(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function exportSelected() {
    if (!selected) {
      return;
    }
    const folder = await open({ directory: true, multiple: false, title: "Export Ogg" });
    if (typeof folder !== "string") {
      return;
    }
    setBusy(selected.uid);
    setBanner(null);
    setLog("");
    try {
      const path = await exportOgg(selected.path, folder, false);
      setBanner(`Exported ${fileName(path)}`);
    } catch (error) {
      setLog(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  function moveTrack(index: number, offset: number) {
    if (!composer) {
      return;
    }
    const next = index + offset;
    if (next < 0 || next >= composer.tracks.length) {
      return;
    }
    const tracks = composer.tracks.slice();
    const [item] = tracks.splice(index, 1);
    tracks.splice(next, 0, item);
    setComposer({ ...composer, tracks });
  }

  const progressTail = useMemo(() => {
    const compact = log.replace(/\s+/g, " ").trim();
    return compact.slice(-72);
  }, [log]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="title-block">
          <h1>TeddyBench</h1>
          <p className="path" title={contentDir ?? undefined}>
            {contentDir ?? "No card open"}
          </p>
        </div>
        <div className="top-actions">
          <button type="button" onClick={() => void chooseFolder()}>
            Choose folder
          </button>
          <button
            type="button"
            onClick={() => contentDir && void refresh(contentDir).catch((error: unknown) =>
              setBanner(error instanceof Error ? error.message : String(error)),
            )}
            disabled={!contentDir || busy !== null}
          >
            Refresh
          </button>
          <button type="button" className="primary" onClick={() => void addAudio()} disabled={busy !== null}>
            New audio
          </button>
        </div>
      </header>

      {banner && (
        <p className="banner" role="status">
          {banner}
        </p>
      )}

      <div className="workspace">
        <section className="library" aria-label="Figures on the card">
          {!contentDir && (
            <div className="empty">
              <h2>Insert the Toniebox SD card</h2>
              <p>Open the CONTENT folder, or pick a drive that already has one.</p>
              {drives.length > 0 && (
                <div className="drive-list">
                  {drives.map((drive) => (
                    <button key={drive} type="button" onClick={() => void refresh(drive).catch((error: unknown) =>
                      setBanner(error instanceof Error ? error.message : String(error)),
                    )}>
                      {drive}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {contentDir && figures.length === 0 && (
            <div className="empty drop-target">
              <h2>This card has no figures yet</h2>
              <p>Drop MP3 or Ogg files here, or choose New audio.</p>
            </div>
          )}

          {figures.length > 0 && (
            <ul className="figure-list">
              {figures.map((figure) => {
                const active = figure.uid === selectedUid;
                const writing = busy === figure.uid;
                return (
                  <li key={figure.uid}>
                    <div
                      role="button"
                      tabIndex={0}
                      data-uid={figure.uid}
                      className={`figure${active ? " active" : ""}${dropUid === figure.uid ? " dropping" : ""}`}
                      onClick={() => {
                        setSelectedUid(figure.uid);
                        setConfirmDelete(false);
                        setChangeUid("");
                      }}
                      onDoubleClick={() => {
                        setRenameUid(figure.uid);
                        setRenameValue(nicknames[figure.uid] ?? "");
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedUid(figure.uid);
                        }
                      }}
                    >
                      {renameUid === figure.uid ? (
                        <input
                          className="rename"
                          value={renameValue}
                          autoFocus
                          aria-label="Nickname"
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => setRenameValue(event.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitRename();
                            }
                            if (event.key === "Escape") {
                              setRenameUid(null);
                            }
                          }}
                        />
                      ) : (
                        <span className="name">{figureLabel(figure, nicknames)}</span>
                      )}
                      <span className="meta">
                        <span className="uid">{figure.uid}</span>
                        <span>{figure.time || "—"}</span>
                        <span>{chapterLabel(figure.chapters)}</span>
                      </span>
                      {writing && progressTail && <span className="row-progress">{progressTail}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <aside className="panel" aria-label="Details">
          {composer && contentDir ? (
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void writeAudio();
              }}
            >
              <div className="panel-heading">
                <h2>{replacing ? "Replace audio" : "New audio"}</h2>
                <button type="button" className="text" onClick={() => setComposer(null)} disabled={busy !== null}>
                  Close
                </button>
              </div>

              <ol className="tracks">
                {composer.tracks.map((track, index) => (
                  <li
                    key={`${track}-${index}`}
                    draggable
                    tabIndex={0}
                    onDragStart={() => setDragIndex(index)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (dragIndex !== null && dragIndex !== index) {
                        const tracks = composer.tracks.slice();
                        const [item] = tracks.splice(dragIndex, 1);
                        tracks.splice(index, 0, item);
                        setComposer({ ...composer, tracks });
                      }
                      setDragIndex(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        moveTrack(index, -1);
                      }
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        moveTrack(index, 1);
                      }
                    }}
                  >
                    <span>{index + 1}</span>
                    <span className="track-name">{fileName(track)}</span>
                    <button
                      type="button"
                      className="text"
                      onClick={() => setPlayer({ title: fileName(track), src: convertFileSrc(track) })}
                    >
                      Play
                    </button>
                    <button
                      type="button"
                      className="text"
                      onClick={() =>
                        setComposer({
                          ...composer,
                          tracks: composer.tracks.filter((_, item) => item !== index),
                        })
                      }
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ol>
              <button
                type="button"
                onClick={() => {
                  void open({
                    multiple: true,
                    title: "Add audio",
                    filters: [{ name: "Audio", extensions: ["mp3", "ogg"] }],
                  }).then((picked) => {
                    if (!picked || !composer) {
                      return;
                    }
                    const extra = Array.isArray(picked) ? picked : [picked];
                    setComposer({ ...composer, tracks: [...composer.tracks, ...extra] });
                  });
                }}
              >
                Add files
              </button>

              <label className="field">
                Destination
                <select
                  value={composer.destination}
                  onChange={(event) =>
                    setComposer({ ...composer, destination: event.target.value, confirming: false })
                  }
                >
                  <option value="">New figure</option>
                  {figures.map((figure) => (
                    <option key={figure.uid} value={figure.uid}>
                      {figureLabel(figure, nicknames)}
                    </option>
                  ))}
                </select>
              </label>

              {!composer.destination && (
                <label className="field">
                  UID
                  <input
                    className="uid-input"
                    value={composer.newUid}
                    spellCheck={false}
                    autoCapitalize="characters"
                    placeholder="E00403…"
                    onChange={(event) =>
                      setComposer({ ...composer, newUid: event.target.value, confirming: false })
                    }
                  />
                </label>
              )}

              <p className={`path-preview${preview?.exists ? " exists" : ""}`}>
                {localPath ?? "Enter a 16-character UID starting with E00403."}
                {preview?.exists ? " · file already on the card" : ""}
              </p>

              <details className="encoding">
                <summary>Encoding</summary>
                <label className="field">
                  Bitrate (kbps)
                  <input
                    type="number"
                    min={16}
                    max={320}
                    value={composer.bitrate}
                    onChange={(event) =>
                      setComposer({
                        ...composer,
                        bitrate: Number(event.target.value) || 96,
                      })
                    }
                  />
                </label>
              </details>

              {composer.confirming && (
                <p className="confirm-copy">
                  Replace the audio on {destinationName}? The file already on the card will be overwritten.
                </p>
              )}

              {log && <pre className="log">{log}</pre>}

              <div className="panel-actions">
                {composer.confirming && (
                  <button type="button" onClick={() => setComposer({ ...composer, confirming: false })}>
                    Back
                  </button>
                )}
                <button className="primary" type="submit" disabled={busy !== null || composer.tracks.length === 0 || !destinationUid}>
                  {busy ? "Writing…" : replacing ? `Replace audio on ${destinationName}` : "Write to card"}
                </button>
              </div>
            </form>
          ) : selected ? (
            <div className="details">
              <h2>{figureLabel(selected, nicknames)}</h2>
              <p className="uid">{selected.uid}</p>
              <p className="meta-line">
                <span>{selected.audioId || "No audio id"}</span>
                <span>{selected.time || "Unknown length"}</span>
                <span>{chapterLabel(selected.chapters)}</span>
              </p>
              <div className="detail-actions">
                <button type="button" onClick={() => void listenTo(selected)} disabled={busy !== null}>
                  Listen
                </button>
                <button type="button" onClick={() => void exportSelected()} disabled={busy !== null}>
                  Export Ogg
                </button>
                <button type="button" onClick={() => void revealItemInDir(selected.path)} disabled={busy !== null}>
                  Show in Explorer
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => setConfirmDelete(true)}
                  disabled={busy !== null}
                >
                  Delete
                </button>
              </div>

              <label className="field">
                Change UID
                <input
                  className="uid-input"
                  value={changeUid}
                  spellCheck={false}
                  placeholder="E00403…"
                  onChange={(event) => setChangeUid(event.target.value)}
                />
              </label>
              <button type="button" onClick={() => void applyChangeUid()} disabled={busy !== null || !normalizeUid(changeUid)}>
                Move file
              </button>
              {normalizeUid(changeUid) && contentDir && (
                <p className="path-preview">{contentPath(contentDir, changeUid)}</p>
              )}

              {confirmDelete && (
                <div className="confirm-block">
                  <p>Delete {figureLabel(selected, nicknames)} from the card? This removes the audio file for that figure.</p>
                  <div className="panel-actions">
                    <button type="button" onClick={() => setConfirmDelete(false)}>
                      Back
                    </button>
                    <button type="button" className="danger" onClick={() => void removeSelected()}>
                      Delete {figureLabel(selected, nicknames)}
                    </button>
                  </div>
                </div>
              )}

              {log && <pre className="log">{log}</pre>}
            </div>
          ) : (
            <div className="empty panel-empty">
              <h2>Figures stay on the card</h2>
              <p>Select one, or drop audio onto it to replace what it plays.</p>
            </div>
          )}

          {player && (
            <div className="player">
              <span>{player.title}</span>
              <audio key={player.src} src={player.src} controls autoPlay />
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

export default App;
