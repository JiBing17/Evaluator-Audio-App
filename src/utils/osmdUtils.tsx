import { extractTempo } from "./fileSelectorUtils";
import { OpenSheetMusicDisplay, Cursor, Fraction } from "opensheetmusicdisplay";
import { Platform } from "react-native";
import scoresData from "../score_name_to_data_map/scoreToMusicxmlMap";

/**
 * Initialize and render OpenSheetMusicDisplay in a **web** environment.
 *
 * @param osmContainerRef - Ref to the HTML div container where OSMD should render.
 * @param osdRef - Mutable ref to store the OSMD instance for later access.
 * @param cursorRef - Mutable ref to store the OSMD cursor instance.
 * @param state - Global or component state containing the selected score name/content.
 * @param dispatch - Function to dispatch actions to update global state.
 * @param isSmallScreen - Flag to adjust zoom for small screen devices.
 * @returns void
 */

export const initOsmdWeb = (
  osmContainerRef: React.RefObject<HTMLDivElement>,
  osdRef: React.MutableRefObject<OpenSheetMusicDisplay | null>,
  cursorRef: React.MutableRefObject<Cursor | null>,
  state: any,
  dispatch: Function,
  isSmallScreen: boolean,
) => {
  if (Platform.OS === "web" && osmContainerRef.current && state.score) {
    // Remove any previously-loaded music
    if (osmContainerRef.current) {
      while (osmContainerRef.current.children[0]) {
        osmContainerRef.current.removeChild(
          osmContainerRef.current.children[0],
        );
      }
    }

    // Create an instance of OpenSheetMusicDisplay, passing the reference to the container
    const osm = new OpenSheetMusicDisplay(
      osmContainerRef.current as HTMLElement,
      {
        autoResize: true, // Enable automatic resizing of the sheet music display
        followCursor: true, // And follow the cursor
      },
    );
    osdRef.current = osm;
    // If score name is a key within ScoreContents use the xml content value within that key, otherwise access xml content through the static key value mapping defined within scores.ts
    const xmlContent =
      (state.scoreContents && state.scoreContents[state.score]) ||
      scoresData[state.score];

    // Error handling if no xml content for selected score is found
    if (!xmlContent) {
      console.error("Score content not found for:", state.score);
      return;
    }
    const tempo = extractTempo(xmlContent); // Extract tempo from selected score (via musicxml)
    // Load and render the XML content.
    osm
      .load(xmlContent)
      .then(() => {
        // Render the sheet music
        osm.render();
        cursorRef.current = osm.cursor;
        cursorRef.current.show(); // Ensure the cursor is visible
        cursorRef.current.CursorOptions = {
          ...cursorRef.current.CursorOptions,
          follow: true,
        };
        osdRef.current!.zoom = 0.65;
        if (isSmallScreen) {
          osdRef.current!.zoom = 0.45;
        }

        dispatch({
          type: "update_piece_info",
          tempo: tempo,
          beatsPerMeasure:
            cursorRef.current.Iterator.CurrentMeasure.ActiveTimeSignature
              .Numerator,
        });
      })
      .catch((error) => {
        // Handle errors in loading the music XML file
        console.error("Error loading music XML:", error);
      });
  }
};

/**
 * Peek at the beat length of the **next note** under the cursor without moving it permanently.
 *
 * @param cursor - OSMD Cursor instance.
 * @param instruments - Array of OSMD Instrument objects.
 * @param timeDenominator - Denominator from the active time signature.
 * @returns Number of beats for the next note (scaled to timeDenominator).
 */
export const peekAtNextBeat = (
  cursor: Cursor,
  instruments: any[],
  timeDenominator: number,
): number => {
  let delta = 0;
  cursor.next();
  const current = cursor.VoicesUnderCursor(instruments[0]);
  if (current.length && current[0].Notes.length) {
    const len = current[0].Notes[0].Length as Fraction;
    const num = len.Numerator === 0 ? 1 : len.Numerator;
    delta = (num / len.Denominator) * timeDenominator;
  } else {
    console.log("No note under cursor.");
  }
  cursor.previous();
  return delta;
};

/**
 * Advance the cursor to the **next note** and return its beat length.
 *
 * @param cursor - OSMD Cursor instance.
 * @param instruments - Array of OSMD Instrument objects.
 * @param timeDenominator - Denominator from the active time signature.
 * @returns Number of beats moved forward (scaled to timeDenominator).
 */

export const advanceToNextBeat = (
  cursor: Cursor,
  instruments: any[],
  timeDenominator: number,
): number => {
  cursor.next();
  const current = cursor.VoicesUnderCursor(instruments[0]);
  let delta = 0;
  if (current.length && current[0].Notes.length) {
    const len = current[0].Notes[0].Length as Fraction;
    const num = len.Numerator === 0 ? 1 : len.Numerator;
    delta = (num / len.Denominator) * timeDenominator;
  } else {
    console.log("No note under cursor.");
  }
  return delta;
};

/**
 * Peek at the beat length of the **current note** under the cursor.
 *
 * @param cursor - OSMD Cursor instance.
 * @param instruments - Array of OSMD Instrument objects.
 * @param timeDenominator - Denominator from the active time signature.
 * @returns Number of beats for the current note (scaled to timeDenominator).
 */
export const peekAtCurrentBeat = (
  cursor: Cursor,
  instruments: any[],
  timeDenominator: number,
): number => {
  let delta = 0;
  const current = cursor.VoicesUnderCursor(instruments[0]);
  if (current.length && current[0].Notes.length) {
    const len = current[0].Notes[0].Length as Fraction;
    const num = len.Numerator === 0 ? 1 : len.Numerator;
    delta = (num / len.Denominator) * timeDenominator;
  } else {
    console.log("No note under cursor.");
  }
  return delta;
};

// Match music21 flatten().notes generated csvs: no rests, all notes (normal, tied, grace)
export function getAllGraphicalNotes(osmd: any): any[] {
  const notes: any[] = [];
  const sheet = osmd.GraphicSheet;
  if (!sheet?.MeasureList) return notes;

  for (const gMeasure of (sheet.MeasureList as any).flat()) {
    for (const staffEntry of gMeasure.staffEntries ?? []) {
      for (const gve of staffEntry.graphicalVoiceEntries ?? []) {
        for (const gNote of gve.notes ?? []) {
          const src = gNote.sourceNote;
          if (!src) continue;

          // filter out rests  as per music21.notes
          if (src.isRest && src.isRest()) continue;

          notes.push(gNote);
        }
      }
    }
  }
  return notes;
}

export function applyNoteColors(
  osmd: any,
  noteColors: { index: number; color: string }[],
) {
  if (!osmd) return;

  const allNotes = getAllGraphicalNotes(osmd);
  console.log("Found", allNotes.length, "graphical notes");
  if (!allNotes.length) return;

  // fast lookup map from index -> color
  const colorMap = new Map<number, string>();
  (noteColors || []).forEach((n) => colorMap.set(n.index, n.color));

  // Clear previous colors for notes not in map
  // allNotes.forEach((gNote) => {
  //   if (gNote?.sourceNote) {
  //     if (typeof gNote.sourceNote.NoteheadColor !== "undefined") gNote.sourceNote.NoteheadColor = null;
  //     if (gNote.sourceNote?.Notehead) gNote.sourceNote.Notehead.color = null;
  //   }
  // });

  allNotes.forEach((gNote: any, idx: number) => {
    const color = colorMap.get(idx);
    if (!color && color !== "") return; // skip if nothing for this note

    try {
      // 1) Preferred: set OSMD's sourceNote.NoteheadColor
      if (gNote?.sourceNote) {
        if (typeof gNote.sourceNote.NoteheadColor !== "undefined") {
          gNote.sourceNote.NoteheadColor = color;
        } else if (gNote.sourceNote.Notehead) {
          // some versions store the notehead object
          gNote.sourceNote.Notehead.color = color;
        } else {
          // last resort: set attribute on sourceNote
          gNote.sourceNote.color = color;
        }
      }

      // 2) VexFlow fallback: try multiple common APIs safely
      const vf = gNote.vfnote;
      if (vf) {
        if (typeof vf.setStyle === "function") {
          vf.setStyle({ fillStyle: color, strokeStyle: color });
        } else if (typeof vf.setAttribute === "function") {
          // Not common, but harmless if present
          try {
            vf.setAttribute("fill", color);
            vf.setAttribute("stroke", color);
          } catch {}
        } else if (vf.attrs && typeof vf.attrs === "object") {
          // Some VexFlow renderers expose attrs
          vf.attrs.fill = color;
          vf.attrs.stroke = color;
        } else if (vf.style && typeof vf.style === "object") {
          // DOM-like style objects (unlikely directly on vfnote)
          vf.style.fill = color;
        } else {
          // If nothing matches, we do nothing to vfnote — rely on sourceNote change above.
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("applyNoteColors: failed for index", idx, err);
    }
  });

  try {
    osmd.render();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("osmd.render() failed", e);
  }
}

/**
 * Builds the complete HTML string for rendering OSMD inside a **React Native WebView**.
 *
 * This HTML:
 * - Loads the OSMD script from CDN.
 * - Renders the provided MusicXML.
 * - Implements `window.stepCursor()` for animating the playback cursor by beats.
 * - Extracts beats-per-measure and tempo from the XML.
 * - Posts a `loaded` message back to the React Native layer via `window.ReactNativeWebView.postMessage(...)`.
 *
 * @param xml - MusicXML content to render.
 * @param defaultZoom - Default zoom factor to apply (defaults to 0.45 for mobile).
 * @returns A self-contained HTML string for injection into a WebView.
 */
export function buildOsmdHtmlForNative(mxmlString: string) {
  const escapedXml = mxmlString
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$")
    .replace(/\n/g, "\\n");

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8" />
      <script src="https://cdn.jsdelivr.net/npm/opensheetmusicdisplay@1.8.7/build/opensheetmusicdisplay.min.js"></script>
      <style>
        body { margin: 0; padding: 0; background: #fff; }
        #osmd-container { width: 100%; height: 100%; }
      </style>
    </head>
    <body>
      <div id="osmd-container"></div>
      <script>
        console.log("[WebView] Initializing OpenSheetMusicDisplay...");

        (async () => {
          // ===== Initialize and load OSMD =====
          const osm = new opensheetmusicdisplay.OpenSheetMusicDisplay(
            document.getElementById('osmd-container'),
            {
              autoResize: true,
              backend: "svg",
              drawTitle: false,
              drawPartNames: false,
              followCursor: true,
            }
          );

          await osm.load(\`${escapedXml}\`);
          osm.render();

          // ===== Expose osm & cursor globally =====
          window.osm = osm;
          window.cursor = osm.cursor;
          osm.cursor.show();
          osm.cursor.CursorOptions = { 
            ...osm.cursor.CursorOptions, 
            follow: true 
          };

          console.log("[WebView] OSMD loaded and cursor initialized");

          // ===== Helper: Apply Note Colors (skip rests) =====
          window.applyNoteColors = function(noteColors) {
            if (!osm || !osm.GraphicSheet) return;

            // Get all graphical notes (skip rests, like music21.notes)
            const allGraphicalNotes = [];
            const measureList = osm.GraphicSheet.MeasureList || [];
            
            for (const staffMeasures of measureList) {
              for (const measure of staffMeasures || []) {
                for (const staffEntry of measure.staffEntries || []) {
                  for (const gve of staffEntry.graphicalVoiceEntries || []) {
                    for (const gNote of gve.notes || []) {
                      const src = gNote.sourceNote;
                      if (src && !(src.isRest && src.isRest())) {
                        allGraphicalNotes.push(gNote);
                      }
                    }
                  }
                }
              }
            }

            console.log("[WebView] Found", allGraphicalNotes.length, "playable notes");

            // Build fast lookup map
            const colorMap = new Map();
            (noteColors || []).forEach(n => colorMap.set(n.index, n.color));

            // Apply colors
            allGraphicalNotes.forEach((gNote, idx) => {
              const color = colorMap.get(idx);
              if (!color && color !== "") return;

              try {
                // 1) Set sourceNote properties (OSMD's preferred method)
                if (gNote.sourceNote) {
                  if (typeof gNote.sourceNote.NoteheadColor !== "undefined") {
                    gNote.sourceNote.NoteheadColor = color;
                  } else if (gNote.sourceNote.Notehead) {
                    gNote.sourceNote.Notehead.color = color;
                  } else {
                    gNote.sourceNote.color = color;
                  }
                }

                // 2) VexFlow fallback
                const vf = gNote.vfnote;
                if (vf) {
                  if (typeof vf.setStyle === "function") {
                    vf.setStyle({ fillStyle: color, strokeStyle: color });
                  }
                  if (vf.note_heads && Array.isArray(vf.note_heads)) {
                    vf.note_heads.forEach(head => {
                      if (head.setStyle) {
                        head.setStyle({ fillStyle: color, strokeStyle: color });
                      }
                    });
                  }
                }
              } catch (err) {
                console.warn("[WebView] Failed to color note", idx, err);
              }
            });

            // Re-render
            try {
              osm.render();
              // console.log("[WebView] Applied", noteColors.length, "note colors");
            } catch (e) {
              console.error("[WebView] osmd.render() failed", e);
            }
          };

          // ===== Cursor Movement Function =====
           window.stepCursor = function(targetBeats) {
            // console.log("[WebView] stepCursor called, target:", targetBeats);

            if (!osm || !osm.cursor || !osm.IsReadyToRender()) {
              console.warn("[WebView] OSMD not ready");
              return;
            }

            const iterator = osm.cursor.Iterator;

            // 1. Identify Context (Beat Unit)
            // Yse the first measure's denominator as the global "beat unit" (e.g. 4 for quarter notes).
            // This ensures 'targetBeats' (which comes from the audio engine) maps consistently to visual time.
            let baseDenom = 4;
            const measureList = osm.GraphicSheet.MeasureList;
            if (measureList && measureList.length > 0 && measureList[0].length > 0) {
                const firstMeasure = measureList[0][0].parentSourceMeasure;
                if (firstMeasure && firstMeasure.ActiveTimeSignature) {
                    baseDenom = firstMeasure.ActiveTimeSignature.Denominator;
                }
            }
            
            function getCurrentBeats() {
              // currentTimeStamp.RealValue is the fraction of a Whole Note (e.g. 0.25 for quarter).
              // Multiply by baseDenom to get "beats".
              return iterator.currentTimeStamp.RealValue * baseDenom;
            }

            let currentBeats = getCurrentBeats();
            const EPSILON = 0.001; // Reduced tolerance for tighter sync

            // 2. Handle Backward Jump
            // If target is significantly behind current, reset to start.
            if (targetBeats < currentBeats - EPSILON) {
                osm.cursor.reset();
                currentBeats = getCurrentBeats();
            }

            // 3. Move Forward Synchronously
            // Advance only if the next position is still <= target.
            const MAX_ITERATIONS = 1000;
            let iterations = 0;
            
            while (iterations < MAX_ITERATIONS) {
               if (osm.cursor.EndOfSheet) break;

               // Snapshot current timestamp
               const preMoveTimestamp = iterator.currentTimeStamp.RealValue;
               
               // Attempt move
               osm.cursor.next();
               
               // Check new position
               const postMoveTimestamp = iterator.currentTimeStamp.RealValue;
               const postMoveBeats = postMoveTimestamp * baseDenom;
               
               // If didn't actually move (e.g. end of sheet), break
               if (postMoveTimestamp === preMoveTimestamp) break;

               // If new position is effectively beyond target, step back and stop.
               if (postMoveBeats > targetBeats + EPSILON) {
                   osm.cursor.previous();
                   break;
               }
               
               // Confirm move and continue
               currentBeats = postMoveBeats;
               iterations++;
            }
            
            // 4. Render updated cursor
            osm.render();
          };

          // ===== Extract Tempo from XML =====
          const rawXML = ${JSON.stringify(escapedXml)};

          function extractTempoFromXML(xmlString) {
            try {
              const parser = new DOMParser();
              const xmlDoc = parser.parseFromString(xmlString, "application/xml");

              const sound = xmlDoc.querySelector("sound[tempo]");
              if (sound?.getAttribute("tempo")) {
                return parseFloat(sound.getAttribute("tempo"));
              }

              const perMin = xmlDoc.querySelector("metronome > per-minute");
              if (perMin?.textContent) {
                return parseFloat(perMin.textContent);
              }

              return null;
            } catch (e) {
              console.warn("Tempo extraction failed:", e);
              return null;
            }
          }

          const tempo = extractTempoFromXML(rawXML);
          const ts = osm.cursor.Iterator.CurrentMeasure.ActiveTimeSignature;

          // ===== Send loaded message to React Native =====
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'loaded',
            tempo: tempo,
            beatsPerMeasure: ts.Numerator,
          }));

          console.log(\`[WebView] OSMD ready: tempo=\${tempo}, beatsPerMeasure=\${ts.Numerator}\`);

        })();

        // ===== Message Handler for React Native =====
        function handleRNMessage(event) {
          try {
            // Log raw event for debugging
            // console.log("[WebView] Raw event received:", JSON.stringify(event));
            
            const msg = JSON.parse(event.data);
            // console.log("[WebView] RN->WebView message:", msg);

            // Handle note coloring
            if (msg.type === "colorNotes" && Array.isArray(msg.noteColors)) {
              window.applyNoteColors(msg.noteColors);
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: "colorNotesAck",
                count: msg.noteColors.length,
              }));
            }
            
            // Handle cursor movement
            else if (msg.type === "moveCursor" && typeof msg.targetBeats === "number") {
              window.stepCursor(msg.targetBeats);
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: "cursorMovedAck",
                targetBeats: msg.targetBeats,
              }));
            }

          } catch (err) {
            console.error("[WebView] Bad RN->WebView message", err);
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: "error",
              message: err.toString(),
            }));
          }
        }

        // ===== Register Message Listeners =====
        if (navigator.userAgent.match(/Android/i)) {
            document.addEventListener("message", handleRNMessage);
        } else {
            // IOS
            window.addEventListener("message", handleRNMessage);
        }

        // Log that listeners are ready
        console.log("[WebView] Message listeners registered for " + (navigator.userAgent.match(/Android/i) ? "Android" : "iOS/Web"));
      </script>
    </body>
    </html>
  `;
}

/**
 * Handles messages sent from the OSMD WebView back to React Native.
 *
 * @param raw - Raw message string from the WebView's `postMessage`.
 * @param dispatch - Function to dispatch state updates in React Native.
 * @returns void
 */
export const onHandleOsmdMessageForNative = (raw: string, dispatch: any) => {
  try {
    const data = JSON.parse(raw);

    switch (data.type) {
      // ---- OSMD finished loading ----
      case "loaded":
        dispatch({
          type: "update_piece_info",
          tempo: data.tempo ?? null,
          beatsPerMeasure: data.beatsPerMeasure ?? null,
        });
        // console.log(`[WebView] OSMD loaded: tempo=${data.tempo}, beatsPerMeasure=${data.beatsPerMeasure}`);
        break;

      // ---- Console messages (bridge from webview) ----
      case "log":
        const msgText = (data.args || []).join(" ");
        if (data.level === "warn") console.warn("[WebView]", msgText);
        else if (data.level === "error") console.error("[WebView]", msgText);
        else console.log("[WebView]", msgText);
        break;

      // ---- Color note confirmation ----
      case "colorNotesAck":
        // console.log(`[WebView] Applied ${data.count} note color updates`);
        // Optional dispatch: dispatch({ type: "color_notes_applied", count: data.count });
        break;

      // ---- Cursor movement confirmation ----
      case "cursorMovedAck":
        // console.log(`[WebView] Cursor moved to beat ${data.targetBeats}`);
        break;

      // ---- Unknown message type ----
      default:
        console.warn("[WebView] Unhandled message type:", data.type, data);
        break;
    }
  } catch (e) {
    console.error("Failed to parse WebView message", e, raw);
  }
};
