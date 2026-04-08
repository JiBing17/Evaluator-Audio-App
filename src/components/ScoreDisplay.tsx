import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  Platform,
  useWindowDimensions,
  ActivityIndicator,
} from "react-native";
import React, { useRef, useEffect, useState, useMemo } from "react";
import { Cursor, OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import scoresData from "../score_name_to_data_map/scoreToMusicxmlMap"; // Local mapping of score filenames to XML content
import { WebView } from "react-native-webview";
import {
  buildOsmdHtmlForNative,
  initOsmdWeb,
  onHandleOsmdMessageForNative,
} from "../utils/osmdUtils"; // Helper functions used to manipulate the OSMD Display
import { sharedApplyNoteColors, sharedStepCursor } from "../utils/osmdSharedLogic";
import { OSMD_CONFIG } from "../utils/osmdConfig";
import { NoteColor } from '../utils/osmdConfig';

export default function ScoreDisplay({
  state,
  dispatch,
}: {
  state: any;
  dispatch: any;
}) {
  const osmContainerRef = useRef<HTMLDivElement | null>(null); // Reference for the SVG container (Web reference to container)
  const cursorRef = useRef<Cursor | null>(null); // Create reference to the OSMD cursor
  const osdRef = useRef<OpenSheetMusicDisplay | null>(null); // Create ref to the OSMD object for web
  const webviewRef = useRef<WebView>(null); // Native-only ref (Used to inject html code into since OSMD is only supported through browser)
  const [steps, setSteps] = useState<string>(""); // state for declaring number of intended cursor iterations
  const [speed, setSpeed] = useState<string>(""); // state solely used for testing cursor movement logic using the commented out code for input in the return below
  const [pitch, setPitch] = useState<string>(""); // state for declaring number of intended cursor iterations

  // Determine if we need to update styles if screen is below a certain threshold
  const { width, height } = useWindowDimensions();
  const isSmallScreen = width < 960;

  const moveCursorByBeats = () => {
    const targetBeats = parseFloat(steps); // Beat value that we want the cursor to be at

    // MOBILE branch: send JS into the WebView to move the cursor (same logic as the web one, can be seen from buildOsmdHtmlForNative helper function)
    if (Platform.OS !== "web") {
      webviewRef.current?.postMessage(JSON.stringify({
        type: "moveCursor",
        targetBeats: targetBeats,
      }));
      return;
    }

    // --- WEB branch ---
    if (!osdRef.current || !osdRef.current.IsReadyToRender()) {
      return;
    }
    sharedStepCursor(osdRef.current, targetBeats);
  };

  const colorNotesInOSMD = (noteColors: NoteColor[]) => {
    if (!noteColors || !noteColors.length) return;
    // MOBILE branch
    if (Platform.OS !== "web") {
      webviewRef.current?.postMessage(JSON.stringify({
        type: "colorNotes",
        noteColors: noteColors,
      }));
      return;
    }

    // WEB branch
    const osmd = osdRef.current;
    if (!osmd) return;
    
    sharedApplyNoteColors(osmd, state.noteColors || []);
}

  // Cursor movement effect
  useEffect(() => {
    const beat = state.estimatedBeat; // Get beat from global state
    if (typeof beat !== "number") return; // Only proceed if beat is valid
    setSteps(String(beat)); // Update step state (beat value we are trying to move the cursor to)
  }, [state.estimatedBeat]); // Queue when global beat value changes

  // Chained cursor movement effect
  useEffect(() => {
    if (steps === "") return; // Chained useeffect to have steps state updated properly before running the cursor movement logic
    moveCursorByBeats(); // Cursor movement using the latest step
  }, [steps, speed]); // Queue when step or speed state (speed var only applicable on testing input) changes

  // Web-only initialization
  useEffect(() => {
    initOsmdWeb(
      osmContainerRef,
      osdRef,
      cursorRef,
      state,
      dispatch,
      isSmallScreen,
    ); // Initializes osdRef and cursorRef
  }, [dispatch, state.score, state.scores]);

  const baseXml =
    (state.scoreContents && state.scoreContents[state.score]) ||
    scoresData[state.score] ||
    ""; // Get selected xml data from given the current score's name

  // Memoize the html source to prevent WebView reloading on every render
  const htmlSource = useMemo(() => {
    const zoom = isSmallScreen ? OSMD_CONFIG.zoomNative.small : OSMD_CONFIG.zoomNative.large;
    return { html: buildOsmdHtmlForNative(baseXml, zoom) };
  }, [baseXml, isSmallScreen]);

  const prevNoteColorsRef = useRef<NoteColor[]>([]);

  // Runtime refresh
  useEffect(() => {
    // console.log("colornote state change");
    const current = state.noteColors || [];
    const prev = prevNoteColorsRef.current;
    const diff: NoteColor[] = [];
    
    // Simple diff: iterate current, check against prev
    // state.noteColors is a sparse array where index matches note index
    current.forEach((note: NoteColor, index: number) => {
        const prevNote = prev[index];
        if (!prevNote || prevNote.color !== note.color) {
            diff.push(note);
        }
    });

    if (diff.length > 0) {
        colorNotesInOSMD(diff);
    }
    
    // Update ref to current state (shallow copy is fine, dispatch new arrays)
    prevNoteColorsRef.current = current;
  }, [state.noteColors]);

  return (
    <>
      {/* Temporary inputs for testing cursor movement */}
      {/* <TextInput
        value={steps}
        onChangeText={setSteps}
        keyboardType="numeric"
        placeholder="Number Of Steps"
      />
      <TextInput
        value={speed}
        onChangeText={setSpeed}
        keyboardType="numeric"
        placeholder="Cursor Update Speed (ms)"
      />

      <TouchableOpacity 
      onPress={moveCursorByBeats}
      >
        <Text>Start</Text>
      </TouchableOpacity> */}

      {/* Reference ScrollView Component for controlling scroll */}
      <ScrollView
        style={styles.scrollContainer}
        contentContainerStyle={{ flexGrow: 1 }}
        showsVerticalScrollIndicator
        scrollEventThrottle={16}
      >
        {/* If on web, render the OSMD container like normal */}
        {Platform.OS === "web" ? (
          <div ref={osmContainerRef} style={styles.osmContainer} />
        ) : (
          // Otherwise use WebView component to render OSMD since it only has web base support so injecting html is the only way
          <WebView
            ref={webviewRef}
            originWhitelist={["*"]}
            source={htmlSource} // Initialize OSMD display and its own separate cursor mvoement logic (same as web)
            onMessage={(e) =>
              onHandleOsmdMessageForNative(e.nativeEvent.data, dispatch)
            } // Call function when page inside this Webview calls postMessage
            style={{ backgroundColor: "transparent", height: 400 }}
          />
        )}

        {state.loadingPerformance && ( // Loading overlay
          <View style={styles.overlay}>
            <ActivityIndicator size="large" />
            <Text style={styles.loadingText}>Loading…</Text>
          </View>
        )}
      </ScrollView>
    </>
  );
}

// Define styles for the components using StyleSheet
const styles = StyleSheet.create({
  scrollContainer: {
    width: "100%", // Make the scroll container fill the width of the parent
    height: "100%", // Set a specific height for scrolling (adjust as needed)
  },
  osmContainer: {
    width: "100%", // Make the sheet music container fill the width of the parent
    borderWidth: 1, // Add border to the sheet music container
    borderColor: "black", // Set border color to black
    overflow: "hidden", // Ensure content doesn't overflow outside this container
  },
  text: {
    fontSize: 20,
    textAlign: "center",
    color: "#2C3E50",
  },

  // Below styles used to have a loading indicator on the top of the OSMD display
  sheetWrapper: {
    position: "relative", // to contain overlay
  },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(255,255,255,0.7)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 10,
    padding: 16,
  },
  loadingText: {
    marginTop: 8,
    fontSize: 16,
    color: "#333",
    fontWeight: 700,
  },
});
