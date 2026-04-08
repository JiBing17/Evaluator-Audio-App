import { OpenSheetMusicDisplay, Cursor } from "opensheetmusicdisplay";
import { Platform } from "react-native";
import scoresData from "../score_name_to_data_map/scoreToMusicxmlMap";
import { sharedApplyNoteColors, sharedStepCursor, getOsmdUnitOptions, sharedExtractTempo, SHARED_OSMD_LOGIC } from "./osmdSharedLogic";
import { OSMD_CONFIG } from "./osmdConfig";

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

    const { osmdOptions, cursorOptions } = getOsmdUnitOptions();

    // Create an instance of OpenSheetMusicDisplay, passing the reference to the container
    const osm = new OpenSheetMusicDisplay(
      osmContainerRef.current as HTMLElement,
      osmdOptions
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
    const tempo = sharedExtractTempo(xmlContent); // Extract tempo from selected score (via musicxml)
    // Load and render the XML content.
    osm
      .load(xmlContent)
      .then(() => {
        // Render the sheet music
        osm.render();
        cursorRef.current = osm.cursor;
        cursorRef.current.show(); // Ensure the cursor is visible
        
        // Unified cursor options
        cursorRef.current.CursorOptions = {
          ...cursorRef.current.CursorOptions,
          ...cursorOptions
        };

        osdRef.current!.zoom = isSmallScreen ? OSMD_CONFIG.zoomWeb.small : OSMD_CONFIG.zoomWeb.large;

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
 * Builds the complete HTML string for rendering OSMD inside a **React Native WebView**.
 *
 * This HTML:
 * - Loads the OSMD script from CDN.
 * - Renders the provided MusicXML.
 * - Implements `window.stepCursor()` for animating the playback cursor by beats.
 * - Extracts beats-per-measure and tempo from the XML.
 * - Posts a `loaded` message back to the React Native layer via `window.ReactNativeWebView.postMessage(...)`.
 *
 * @param mxmlString - MusicXML content to render.
 * @param zoom - Zoom level for the sheet music (default 1.0).
 * @param cursorColor - Color for the playback cursor (default from OSMD_CONFIG).
 * @returns A self-contained HTML string for injection into a WebView.
 */
export function buildOsmdHtmlForNative(
  mxmlString: string,
  zoom: number = 1.0,
  cursorColor: string = OSMD_CONFIG.cursorColor,
) {
  const escapedXml = mxmlString
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$")
    .replace(/\n/g, "\\n");

  const { osmdOptions, cursorOptions } = getOsmdUnitOptions(cursorColor);

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

        // Inject shared logic from AUTHORITATIVE strings (bypasses Hermes bytecode stripping)
        window.sharedApplyNoteColors = ${SHARED_OSMD_LOGIC.applyNoteColors};
        window.sharedStepCursor = ${SHARED_OSMD_LOGIC.stepCursor};
        window.sharedExtractTempo = ${SHARED_OSMD_LOGIC.extractTempo};

        (async () => {
          // ===== Initialize and load OSMD =====
          const osm = new opensheetmusicdisplay.OpenSheetMusicDisplay(
            document.getElementById('osmd-container'),
            ${JSON.stringify(osmdOptions)}
          );

          await osm.load(\`${escapedXml}\`);
          osm.zoom = ${zoom};
          osm.render();

          // ===== Expose osm & cursor globally =====
          window.osm = osm;
          window.cursor = osm.cursor;
          osm.cursor.show();
          osm.cursor.CursorOptions = { 
            ...osm.cursor.CursorOptions, 
            ...${JSON.stringify(cursorOptions)}
          };

          console.log("[WebView] OSMD loaded and cursor initialized");

          // ===== Extract Tempo from XML =====
          const rawXML = ${JSON.stringify(escapedXml)};
          const tempo = window.sharedExtractTempo(rawXML);
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
            const msg = JSON.parse(event.data);

            if (msg.type === "colorNotes" && Array.isArray(msg.noteColors)) {
              window.sharedApplyNoteColors(window.osm, msg.noteColors);
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: "colorNotesAck",
                count: msg.noteColors.length,
              }));
            }
            
            else if (msg.type === "moveCursor" && typeof msg.targetBeats === "number") {
              window.sharedStepCursor(window.osm, msg.targetBeats);
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

        console.log("[WebView] Message listeners registered");
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
        break;

      // ---- Cursor movement confirmation ----
      case "cursorMovedAck":
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
