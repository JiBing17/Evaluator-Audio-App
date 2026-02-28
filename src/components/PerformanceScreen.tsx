import React, { useState, useRef, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  TextInput,
} from "react-native";

import {
  NativeModules,
  Platform,
  NativeEventEmitter,
  Alert,
} from "react-native";

import { requestMicrophonePermission } from "../utils/liveMicUtils";

import { CENSFeatures } from "../audio/FeaturesCENS";
import { FeaturesConstructor } from "../audio/Features";
import { CSVRow, loadCsvInfo } from "../utils/csvParsingUtils";
import { getScoreCSVData } from "../score_name_to_data_map/unifiedScoreMap";

import {
  intonationToNoteColor,
  calculateSingleNoteIntonation,
  listMedian,
  hzToMidi,
  MISTAKE_THRESHOLD,
  SEMITONE_FILTER_THRESHOLD,
} from "../audio/Intonation";
import { NoteColor } from "../utils/musicXmlUtils";

import { PerformanceData } from "./PerformanceStats";
import { getCurrentUser, savePerformanceData } from "../utils/accountUtils";

interface PerformanceScreenProps {
  score: string; // Selected score name
  dispatch: (action: { type: string; payload?: any }) => void; // Dispatch function used to update global state
  bpm?: number; // Optional BPM number,
  FeaturesCls?: FeaturesConstructor<any>;
  state: any;
}

// Semitone based params
const ADVANCE_THRESHOLD = MISTAKE_THRESHOLD;
const MIN_ADVANCE_TIME = 10; // ms
const SAME_PITCH_WAIT_FRACTION = 0.5;

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
  FeaturesCls = CENSFeatures,
  state,
}: PerformanceScreenProps) {
  const expNoteIdxRef = useRef<number>(0);
  const noteColorsRef = useRef<NoteColor[]>([]);
  const csvDataRef = useRef<CSVRow[]>([]);

  const pitchBufferRef = useRef<number[]>([]); // Buffer for median filtering
  const noteMistakesRef = useRef<number[]>([]); // Buffer for mistake categorization

  const lastAdvanceTimeRef = useRef<number>(0);

  const intonationDataRef = useRef<number[]>([]);
  const durationRatioDataRef = useRef<number[]>([]);

  const [performanceComplete, setPerformanceComplete] = useState(false); // State to determine if plackback of a score is finished or not
  const [performanceSaved, setPerformanceSaved] = useState(false); // State to track if performance has been saved

  const [isProcessing, setIsProcessing] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  const updateScheduled = useRef<boolean>(false);
  const latestBeat = useRef<number>(0);
  const lastDispatchedBeat = useRef<number | null>(null);

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
      "onPitchDetected",
      handlePitchUpdate,
    );
    console.log("Subscription:", subscription);

    return () => {
      console.log("Subscription teardown");
      subscription.remove();
      AudioPerformanceModule.stopProcessing();
      setIsProcessing(false);
    };
  }, [dispatch]);

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
    pitchBufferRef.current = []; // Reset buffer
    noteMistakesRef.current = [];

    lastAdvanceTimeRef.current = Date.now();
    intonationDataRef.current = [];
    durationRatioDataRef.current = [];

    const base = score.replace(/\.musicxml$/, "");
    const csvUri = getScoreCSVData(base);
    const noteTable = await loadCsvInfo(csvUri);
    csvDataRef.current = noteTable;

    console.log("Isplaying=", state.playing, "\nDispatch start/stop");
    dispatch({ type: "SET_NOTE_COLORS", payload: [] });
    dispatch({ type: "start/stop" });
    setIsPaused(false);
    setPerformanceComplete(false);
    setPerformanceSaved(false);

    // Start Native Audio Engine
    if (AudioPerformanceModule?.startProcessing) {
      await AudioPerformanceModule.startProcessing();
      setIsProcessing(true);
    }
  };

  const togglePause = async () => {
    if (
      !AudioPerformanceModule?.stopProcessing ||
      !AudioPerformanceModule?.startProcessing
    )
      return;

    if (isPaused) {
      await AudioPerformanceModule.startProcessing();
      setIsPaused(false);
    } else {
      await AudioPerformanceModule.stopProcessing();
      setIsPaused(true);
    }
  };

  const restartPerformance = async () => {
    if (
      !AudioPerformanceModule?.stopProcessing ||
      !AudioPerformanceModule?.startProcessing
    )
      return;

    await AudioPerformanceModule.stopProcessing();
    setIsProcessing(false);
    setIsPaused(false);

    expNoteIdxRef.current = 0;
    noteColorsRef.current = [];
    pitchBufferRef.current = []; // Reset buffer
    noteMistakesRef.current = [];

    lastAdvanceTimeRef.current = Date.now();
    intonationDataRef.current = [];
    durationRatioDataRef.current = [];

    dispatch({ type: "SET_NOTE_COLORS", payload: [] });
    dispatch({ type: "SET_ESTIMATED_BEAT", payload: 0 });
    setPerformanceComplete(false);
    setPerformanceSaved(false);

    await AudioPerformanceModule.startProcessing();
    setIsProcessing(true);
  };

  const handlePitchUpdate = async (freq: number) => {
    // console.log("Pitch update:", freq);
    if (freq <= 0) return;

    const noteTable: CSVRow[] = csvDataRef.current;
    const expNoteIndex = expNoteIdxRef.current;

    if (!noteTable || expNoteIndex >= noteTable.length) return;

    const targetNote = noteTable[expNoteIndex];

    // 1. Convert to MIDI
    const detectedMidi = hzToMidi(freq);

    // 2. Octave-corrected gated intonation correction (gated by SEMITONE_FILTER_THRESHOLD, OCTAVE_FILTER_THRESHOLD) from Intonation.tsx
    const sampleIntonation = calculateSingleNoteIntonation(
      detectedMidi,
      targetNote.midi,
    );
    // Silence or filtered note
    if (Number.isNaN(sampleIntonation)) return;

    // 3. Median Buffering
    const buffer = pitchBufferRef.current;
    buffer.push(sampleIntonation);
    if (buffer.length > 5) buffer.shift(); // Keep last 5 samples

    const intonation = listMedian(buffer);
    console.log("[DEBUG] Into", intonation);

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

    // Don't advance note if out of range
    if (Math.abs(intonation) > ADVANCE_THRESHOLD) {
      // Add to mistake aggregate
      noteMistakesRef.current.push(intonation);
    } else {
      // Advance note
      const now = Date.now();
      const timeSinceLastAdvance = now - lastAdvanceTimeRef.current;

      let noteIntonation = 0.0;
      let noteDurationRatio = 1.0;

      // Check general time constraint
      if (timeSinceLastAdvance < MIN_ADVANCE_TIME) return;

      // Check same pitch class constraint
      if (expNoteIndex + 1 < noteTable.length) {
        const currentNote = noteTable[expNoteIndex];
        const nextNote = noteTable[expNoteIndex + 1];

        let expectedDuration = (nextNote.refTime - currentNote.refTime) * 1000;
        // TEST: uncomment to follow user tempo
        // expectedDuration *= median(durationRatioDataRef.current.slice(-5));

        // If next note is same pitch class (e.g. C4 and C5, or same note)
        if (currentNote.midi % 12 === nextNote.midi % 12) {
          // Wait fraction of the time between notes
          if (
            timeSinceLastAdvance <
            expectedDuration * SAME_PITCH_WAIT_FRACTION
          ) {
            return;
          }
        }

        // Store duration of actual advance time to expected duration
        noteDurationRatio = timeSinceLastAdvance / expectedDuration;
      }

      // ADVANCE LOGIC
      // console.log("Abs of", intonation, "was within threshold", ADVANCE_THRESHOLD);

      // Performance Metrics
      if (noteMistakesRef.current.length > 0) noteIntonation = listMedian(noteMistakesRef.current);
      // Set intonation for attempt according to mistake buffer for note
      intonationDataRef.current.push(noteIntonation);
      // Set duration ratio for attempt based on above check
      durationRatioDataRef.current.push(noteDurationRatio);

      // Move note pointer
      expNoteIdxRef.current = expNoteIndex + 1;
      lastAdvanceTimeRef.current = now;

      // Reset buffers for next note
      pitchBufferRef.current = [];
      noteMistakesRef.current = [];
    }

    if (expNoteIdxRef.current < noteTable.length) {
      const beat = noteTable[expNoteIdxRef.current].beat;
      // update beat to move cursor
      scheduleBeatUpdate(beat);
    } else {
      await AudioPerformanceModule.stopProcessing();
      setIsProcessing(false);
      setIsPaused(false);
      setPerformanceComplete(true);
    }
  };

  const handleTimePitchUpdate = (estTime: number, freq: number) => {
    const noteTable: CSVRow[] = csvDataRef.current;
    if (!noteTable || expNoteIdxRef.current >= noteTable.length) return;

    const currentIndex = expNoteIdxRef.current;
    const targetNote = noteTable[currentIndex];

    // 1. Buffer pitch for current note
    if (freq > 0) {
      const midi = hzToMidi(freq);
      const intonation = calculateSingleNoteIntonation(midi, targetNote.midi);

      if (!Number.isNaN(intonation)) {
        pitchBufferRef.current.push(intonation);
      }
    }

    // 2. Advance if estTime has reached the refTime of the NEXT note
    if (
      currentIndex + 1 < noteTable.length &&
      estTime >= noteTable[currentIndex + 1].refTime
    ) {
      // Color now-finished note based on buffer
      const medianIntonation =
        pitchBufferRef.current.length > 0
          ? listMedian(pitchBufferRef.current)
          : 0;

      const noteColor = intonationToNoteColor(medianIntonation, currentIndex);

      if (noteColorsRef.current[currentIndex]?.color !== noteColor.color) {
        noteColorsRef.current[currentIndex] = noteColor;
        dispatch({
          type: "ADD_NOTE_COLOR",
          payload: { color: noteColor, index: currentIndex },
        });
      }

      // Save performance metrics for now-finished note
      intonationDataRef.current.push(medianIntonation);
      durationRatioDataRef.current.push(1.0); // Default for time-based tracking

      // Flush the buffer for the next note
      pitchBufferRef.current = [];

      // Advance cursor
      let nextIndex = currentIndex + 1;
      while (
        nextIndex + 1 < noteTable.length &&
        estTime >= noteTable[nextIndex + 1].refTime
      ) {
        // Push default values for skipped notes to keep metrics aligned
        intonationDataRef.current.push(0);
        durationRatioDataRef.current.push(1.0);
        nextIndex++;
      }
      expNoteIdxRef.current = nextIndex;

      // Move cursor to new note
      const newTargetNote = noteTable[nextIndex];
      scheduleBeatUpdate(newTargetNote.beat);
    } else {
      // Still on the same note, ensure cursor/beat is correct
      scheduleBeatUpdate(targetNote.beat);
    }
  };

  const saveCurrentPerformance = async () => {
    const user = await getCurrentUser();
    if (!user) {
      console.log("No user logged in");
      alert("Please log in to save performance data");
      return;
    }

    const performanceData: PerformanceData = {
      id: Date.now().toString(),
      scoreName: score || "unknown",
      timestamp: new Date().toISOString(),
      tempo: bpm,
      intonationData: intonationDataRef.current,
      durationRatioData: durationRatioDataRef.current,
      csvData: csvDataRef.current,
    };

    await savePerformanceData(performanceData);
    setPerformanceSaved(true);
    console.log("Performance saved successfully");
    alert("Performance saved successfully!");
  };

  return (
    <View>
      {/* Show tempo of selected score to be played */}
      {bpm ? (
        <Text style={styles.tempoText}>Reference Tempo: {bpm} BPM</Text>
      ) : null}

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

      {/* Stop Performance button */}
      <TouchableOpacity
        style={styles.button}
        onPress={() => {
          AudioPerformanceModule.stopProcessing();
          dispatch({ type: "start/stop" });
          setIsPaused(false);
        }}
        disabled={state.score === "" || !state.playing}
      >
        <Text style={styles.buttonText}>Stop</Text>
      </TouchableOpacity>

      {/* Resume/Pause Performance button */}
      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[
            styles.button,
            styles.halfButton,
            styles.pauseButton,
            !state.playing && !isPaused && styles.disabledButton,
          ]}
          onPress={togglePause}
          disabled={!state.playing && !isPaused}
        >
          <Text style={styles.buttonText}>{isPaused ? "Resume" : "Pause"}</Text>
        </TouchableOpacity>

        {/* Restart Performance button */}
        <TouchableOpacity
          style={[
            styles.button,
            styles.halfButton,
            styles.lastHalfButton,
            styles.restartButton,
            !state.playing && !isPaused && styles.disabledButton,
          ]}
          onPress={restartPerformance}
          disabled={!state.playing && !isPaused}
        >
          <Text style={styles.buttonText}>Restart</Text>
        </TouchableOpacity>

        {/* Save Performance button */}
        <TouchableOpacity
          style={[
            styles.button,
            styles.saveButton,
            (!performanceComplete || performanceSaved) && styles.disabledButton,
          ]}
          onPress={saveCurrentPerformance}
          disabled={!performanceComplete || performanceSaved}
        >
          <Text style={styles.buttonText}>
            {performanceSaved ? "Performance Saved ✓" : "Save Performance"}
          </Text>
        </TouchableOpacity>
      </View>
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
  buttonRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
  },
  halfButton: {
    flex: 1,
    marginRight: 8,
  },
  lastHalfButton: {
    marginRight: 0,
  },
  pauseButton: {
    backgroundColor: "#8E44AD",
  },
  restartButton: {
    backgroundColor: "#34495E",
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
