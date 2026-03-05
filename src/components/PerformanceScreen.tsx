import React, { useState, useRef, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  Switch,
} from "react-native";

import {
  NativeModules,
  Platform,
  NativeEventEmitter,
  Alert,
} from "react-native";

import { requestMicrophonePermission } from "../utils/liveMicUtils";

import { CSVRow, loadCsvInfo } from "../utils/csvParsingUtils";
import {
  getScoreCSVData,
  getScoreRefAudio,
} from "../score_name_to_data_map/unifiedScoreMap";

import { intonationToNoteColor } from "../audio/Intonation";
import { NoteColor } from "../utils/musicXmlUtils";

interface PerformanceScreenProps {
  score: string; // Selected score name
  dispatch: (action: { type: string; payload?: any }) => void; // Dispatch function used to update global state
  bpm?: number; // Optional BPM number
  state: any;
}

const ADVANCE_THRESHOLD = 0.2;
const SAMPLE_RATE = 44100;
const FRAME_SIZE = 4096;

// DTW parameters
const DTW_WINDOW_SIZE = 50;
const DTW_MAX_RUN_COUNT = 3;
const DTW_DIAG_WEIGHT = 0.75;

let AudioPerformanceModule: any;
if (Platform.OS === "android") {
  try {
    console.log("Loading AudioPerformanceModule...");
    AudioPerformanceModule = NativeModules.AudioPerformanceModule;
    console.log("AudioPerformanceModule instance:", AudioPerformanceModule);
  } catch (e) {
    console.log("Failed to load AudioPerformanceModule: ", e);
  }
}

const audioEvents = new NativeEventEmitter(AudioPerformanceModule);

export default function PerformanceScreen({
  score,
  dispatch,
  bpm = 100,
  state,
}: PerformanceScreenProps) {
  const expNoteIdxRef = useRef<number>(0);
  const noteColorsRef = useRef<NoteColor[]>([]);
  const csvDataRef = useRef<CSVRow[]>([]);

  const [isProcessing, setIsProcessing] = useState(false);
  const [testInput, setTestInput] = useState<number>(0);
  const [useDTWMode, setUseDTWMode] = useState(true); // true = DTW, false = Note-by-Note
  const useDTWModeRef = useRef(true); // Ref to access current mode in event handler
  const updateScheduled = useRef<boolean>(false);
  const latestBeat = useRef<number>(0);
  const lastDispatchedBeat = useRef<number | null>(null);

  // Keep ref in sync with state
  useEffect(() => {
    useDTWModeRef.current = useDTWMode;
  }, [useDTWMode]);

  const scheduleBeatUpdate = (beat: number) => {
    latestBeat.current = beat;
    if (!updateScheduled.current) {
      updateScheduled.current = true;
      requestAnimationFrame(() => {
        if (latestBeat.current !== lastDispatchedBeat.current) {
          dispatch({ type: "SET_ESTIMATED_BEAT", payload: latestBeat.current });
          lastDispatchedBeat.current = latestBeat.current;
        }
        updateScheduled.current = false;
      });
    }
  };

  useEffect(() => {
    console.log("Adding subscription to audio events");
    const subscription = audioEvents.addListener(
      "onAudioFrame",
      handleAudioFrame,
    );
    console.log("Subscription:", subscription);

    return () => {
      console.log("Subscription teardown");
      subscription.remove();
      AudioPerformanceModule.stopProcessing();
      setIsProcessing(false);
    };
  }, [dispatch]);

  /**
   * Handle audio frame events from native module.
   * Event contains: { refPosition: number, pitch: number, probability: number }
   *
   * In DTW mode: refPosition is the DTW-aligned position in the reference sequence.
   * In Note-by-Note mode: we ignore refPosition and use pitch to advance.
   */
  const handleAudioFrame = (event: {
    refPosition: number;
    pitch: number;
    probability: number;
  }) => {
    const { refPosition, pitch } = event;

    if (useDTWModeRef.current) {
      // DTW Mode: Use time-based tracking from DTW alignment
      // refPosition is -1 if DTW is not initialized
      if (refPosition < 0) {
        return;
      }

      // Convert reference position to time in seconds
      // Each frame is FRAME_SIZE samples at SAMPLE_RATE Hz
      // refPosition 0 = time 0, refPosition 1 = time 0.093s, etc.
      const estTime = (refPosition * FRAME_SIZE) / SAMPLE_RATE;

      // Use DTW-aligned time tracking
      handleTimePitchUpdate(estTime, pitch);
    } else {
      // Note-by-Note Mode: Use pitch-based advancement
      handlePitchUpdate(pitch);
    }
  };

  /**
   * Load reference audio and initialize native DTW.
   * Audio is loaded and CENS features are computed entirely in native code
   * to avoid memory issues from large data transfers over the bridge.
   */
  const initializeDTW = async (scoreName: string): Promise<boolean> => {
    try {
      console.log("-- Initializing native DTW...");

      // Get reference audio URI
      const refAudioUri = getScoreRefAudio(scoreName);
      console.log("-- Reference audio URI:", refAudioUri);

      // Initialize native DTW with audio URL - native code will download and process
      console.log("-- Sending URL to native DTW (audio loaded natively)...");
      await AudioPerformanceModule.initializeDTWFromUrl(
        refAudioUri,
        DTW_WINDOW_SIZE,
        DTW_MAX_RUN_COUNT,
        DTW_DIAG_WEIGHT,
      );
      console.log("-- Native DTW initialized successfully");

      return true;
    } catch (e) {
      console.error("Failed to initialize DTW:", e);
      return false;
    }
  };

  const runPerformance = async () => {
    const hasPermission = await requestMicrophonePermission();
    if (!hasPermission) {
      Alert.alert(
        "Permission Denied",
        "Microphone access is required to run the performance.",
      );
      return;
    }

    if (!score) return;

    expNoteIdxRef.current = 0;
    noteColorsRef.current = [];

    const base = score.replace(/\.musicxml$/, "");
    const csvUri = getScoreCSVData(base);
    const noteTable = await loadCsvInfo(csvUri);
    csvDataRef.current = noteTable;

    console.log("Isplaying=", state.playing, "\nDispatch start/stop");
    console.log("Mode:", useDTWMode ? "DTW" : "Note-by-Note");
    dispatch({ type: "SET_NOTE_COLORS", payload: [] });
    dispatch({ type: "start/stop" });

    // Initialize native DTW with reference audio (only in DTW mode)
    if (useDTWMode) {
      const dtwInitialized = await initializeDTW(base);
      if (!dtwInitialized) {
        console.warn(
          "DTW initialization failed - score following may not work correctly",
        );
      }
    } else {
      console.log("Note-by-Note mode - skipping DTW initialization");
    }

    // Start Native Audio Engine
    await AudioPerformanceModule.startProcessing();
    setIsProcessing(true);
  };

  const handlePitchUpdate = (freq: number) => {
    // console.log("Pitch update:", freq);

    const noteTable: CSVRow[] = csvDataRef.current;
    const expNoteIndex = expNoteIdxRef.current;

    if (!noteTable || expNoteIndex >= noteTable.length) return;

    const targetNote = noteTable[expNoteIndex];

    const intonation: number = calculateIntonation(freq, targetNote);
    // silence or no note
    if (Number.isNaN(intonation)) return;

    // update note color of latest attempt
    // console.log("Intonation", intonation, intonationToNoteColor(intonation, expNoteIndex), noteColorsRef.current);
    const newNoteColor = intonationToNoteColor(intonation, expNoteIndex);

    // Check if color actually changed to avoid unnecessary re-renders/bridge traffic
    if (noteColorsRef.current[expNoteIndex]?.color !== newNoteColor.color) {
      noteColorsRef.current[expNoteIndex] = newNoteColor;
      dispatch({
        type: "ADD_NOTE_COLOR",
        payload: { color: newNoteColor, index: expNoteIndex },
      });
    }

    // if attempt within range, advance note
    if (Math.abs(intonation) < ADVANCE_THRESHOLD) {
      // console.log("Abs of", intonation, "was within threshold", ADVANCE_THRESHOLD);
      expNoteIdxRef.current = expNoteIndex + 1;
    }

    if (expNoteIdxRef.current < noteTable.length) {
      const beat = noteTable[expNoteIdxRef.current].beat;
      // update beat to move cursor
      scheduleBeatUpdate(beat);
    }
  };

  const handleTimePitchUpdate = (estTime: number, freq: number) => {
    let expNoteIndex = expNoteIdxRef.current;
    const noteTable: CSVRow[] = csvDataRef.current;

    // Safety checks
    if (!noteTable || noteTable.length === 0) return;
    if (expNoteIndex >= noteTable.length) return;

    // Get the time of the NEXT note (if any) to decide when to advance
    // We stay on the current note until estTime passes the next note's start time
    while (expNoteIndex < noteTable.length - 1) {
      const nextNoteTime = noteTable[expNoteIndex + 1].refTime;
      if (estTime >= nextNoteTime) {
        expNoteIndex += 1;
        expNoteIdxRef.current = expNoteIndex;
        console.log(expNoteIndex, noteTable.length);
      } else {
        break;
      }
    }

    // Safety check after loop
    if (expNoteIdxRef.current >= noteTable.length) return;

    const targetNote = noteTable[expNoteIdxRef.current];
    if (!targetNote) return;

    const beat = targetNote.beat;
    if (beat !== undefined && beat !== null) {
      scheduleBeatUpdate(beat);
    }

    const intonation = calculateIntonation(freq, targetNote);

    // silence or no note
    if (Number.isNaN(intonation)) return;

    // update note color of latest attempt
    // console.log("Intonation", intonation);
    const newNoteColor = intonationToNoteColor(intonation, expNoteIndex);

    // Check if color actually changed to avoid unnecessary re-renders/bridge traffic
    if (noteColorsRef.current[expNoteIndex]?.color !== newNoteColor.color) {
      noteColorsRef.current[expNoteIndex] = newNoteColor;
      dispatch({
        type: "ADD_NOTE_COLOR",
        payload: { color: newNoteColor, index: expNoteIndex },
      });
    }
  };

  function calculateIntonation(freq: number, targetNote: CSVRow) {
    if (freq < 0) {
      return NaN;
    }

    const midi = 69 + 12 * Math.log2(freq / 440);
    const intonation = targetNote.midi - midi;

    return intonation % 12;
  }

  const testNbnOnce = () => {
    handlePitchUpdate(testInput);
  };

  return (
    <View>
      {/* Show tempo of selected score to be played */}
      {bpm ? (
        <Text style={styles.tempoText}>Reference Tempo: {bpm} BPM</Text>
      ) : null}

      {/* Mode Toggle */}
      <View style={styles.modeToggleContainer}>
        <Text style={styles.modeLabel}>Note-by-Note</Text>
        <Switch
          value={useDTWMode}
          onValueChange={setUseDTWMode}
          disabled={state.playing} // Can't change mode while playing
          trackColor={{ false: "#767577", true: "#81b0ff" }}
          thumbColor={useDTWMode ? "#2C3E50" : "#f4f3f4"}
        />
        <Text style={styles.modeLabel}>DTW</Text>
      </View>
      <Text style={styles.modeDescription}>
        {useDTWMode
          ? "DTW: Follows along with your playing tempo"
          : "Note-by-Note: Advances when correct pitch is detected"}
      </Text>

      {/* Start Performance button */}
      <TouchableOpacity
        style={[
          styles.button,
          (state.score === "" || state.playing) && styles.disabledButton,
        ]}
        onPress={runPerformance}
        disabled={state.score === "" || state.playing} // Disabled when no score is selected or already playing performance
      >
        <Text style={styles.buttonText}>
          {state.playing ? "Listening..." : "Play"}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.button}
        onPress={() => {
          AudioPerformanceModule.stopProcessing();
          dispatch({ type: "start/stop" });
        }}
        disabled={state.score === "" || !state.playing}
      >
        <Text style={styles.buttonText}>Stop</Text>
      </TouchableOpacity>

      {/* Temporary inputs for testing cursor movement */}
      <TextInput
        value={testInput.toString()}
        onChangeText={(text) => setTestInput(parseFloat(text))}
        keyboardType="numeric"
        placeholder="Frame value"
      />

      <TouchableOpacity
        style={[
          styles.button,
          (state.score === "" || !state.playing) && styles.disabledButton,
        ]}
        onPress={testNbnOnce}
        disabled={state.score === "" || !state.playing} // Disabled when no score is selected or not playing performance
      >
        <Text style={styles.buttonText}>NBN: Feed Test Frame</Text>
      </TouchableOpacity>
    </View>
  );
}

// Define styles for the components using StyleSheet
const styles = StyleSheet.create({
  button: {
    padding: 12,
    backgroundColor: "#2C3E50",
    borderRadius: 8,
    alignItems: "center",
  },
  saveButton: {
    marginTop: 8,
    backgroundColor: "#27AE60",
  },
  disabledButton: {
    backgroundColor: "#555",
  },
  buttonText: {
    color: "#FFF",
    fontWeight: "bold",
    fontSize: 14,
  },
  status: {
    marginTop: 16,
    alignItems: "center",
  },
  label: {
    fontSize: 16,
    color: "#333",
  },
  tempoText: {
    fontSize: 18,
    color: "#2C3E50",
    fontWeight: "bold",
    // Text shadow properties
    textShadowColor: "rgba(0, 0, 0, 0.1)", // Shadow color with transparency
    textShadowOffset: { width: 1, height: 1 }, // Slight offset
    textShadowRadius: 4,
    textAlign: "left",
    marginBottom: 8,
  },
  modeToggleContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 8,
    gap: 8,
  },
  modeLabel: {
    fontSize: 14,
    color: "#2C3E50",
    fontWeight: "500",
  },
  modeDescription: {
    fontSize: 12,
    color: "#666",
    textAlign: "center",
    marginBottom: 12,
    fontStyle: "italic",
  },
  hiddenInput: {
    display: "none",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginVertical: 4,
  },
  pickerContainer: {
    flex: 1,
    marginRight: 8,
    minWidth: 0, // allow shrinking so text can ellipsize
  },
  graphContainer: {
    flexShrink: 0, // keep graph its intrinsic size
  },
  fileButton: {
    padding: 12,
    backgroundColor: "#2C3E50",
    borderRadius: 8,
    alignItems: "center",
    marginBottom: 8,
    // optional hard cap to be safer:
    maxWidth: 220,
  },
});
