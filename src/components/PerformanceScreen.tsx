import React, { useState, useRef, useEffect } from "react";
import Slider from "@react-native-community/slider";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Switch,
  Modal,
} from "react-native";

import {
  NativeModules,
  Platform,
  NativeEventEmitter,
  Alert,
} from "react-native";

import { requestMicrophonePermission } from "../utils/liveMicUtils";
import {
  intonationToNoteColor,
  calculateSingleNoteIntonation,
  listMedian,
  hzToMidi,
  MISTAKE_THRESHOLD,
  MISTAKE_THRESHOLD_MIN,
  MISTAKE_THRESHOLD_MAX,
  MISTAKE_THRESHOLD_STEP,
  SEMITONE_FILTER_THRESHOLD,
  SEMITONE_FILTER_THRESHOLD_MIN,
  SEMITONE_FILTER_THRESHOLD_MAX,
  SEMITONE_FILTER_THRESHOLD_STEP,
  OCTAVE_FILTER_THRESHOLD,
  OCTAVE_FILTER_THRESHOLD_MIN,
  OCTAVE_FILTER_THRESHOLD_MAX,
  OCTAVE_FILTER_THRESHOLD_STEP,
} from "../audio/Intonation";

import { CSVRow, loadCsvInfo } from "../utils/csvParsingUtils";
import {
  getScoreCSVData,
  getScoreRefAudio,
} from "../score_name_to_data_map/unifiedScoreMap";
import scoreToMidi from "../score_name_to_data_map/scoreToMidi";

import { NoteColor } from "../utils/osmdConfig";

import { PerformanceData } from "./PerformanceStats";
import { getCurrentUser, savePerformanceData } from "../utils/accountUtils";

interface PerformanceScreenProps {
  score: string; // Selected score name
  dispatch: (action: any) => void; // Dispatch function used to update global state
  bpm?: number; // Optional BPM number
  state: any;
}

// Semitone based params
const ADVANCE_THRESHOLD = MISTAKE_THRESHOLD;
const MIN_ADVANCE_TIME = 10; // ms
const SAME_PITCH_WAIT_FRACTION = 0.5;
const PITCH_WARNING_WINDOW = 12;
const PITCH_WARNING_MIN = 8;
const PITCH_WARNING_COOLDOWN_MS = 3000;
const PITCH_WARNING_DURATION_MS = 2000;

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

  const pitchBufferRef = useRef<number[]>([]); // Buffer for median filtering
  const noteMistakesRef = useRef<number[]>([]); // Buffer for mistake categorization
  const pitchWarningBufferRef = useRef<number[]>([]);
  const pitchWarningTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPitchWarningRef = useRef<number>(0);

  const lastAdvanceTimeRef = useRef<number>(0);
  const lastInitializedScoreRef = useRef<string | null>(null);

  const intonationDataRef = useRef<number[]>([]);
  const durationRatioDataRef = useRef<number[]>([]);

  const [performanceComplete, setPerformanceComplete] = useState(false); // State to determine if plackback of a score is finished or not
  const [performanceSaved, setPerformanceSaved] = useState(false); // State to track if performance has been saved

  const [isProcessing, setIsProcessing] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  // Audio parameter controls
  const [mistakeThreshold, setMistakeThreshold] = useState(MISTAKE_THRESHOLD);
  const [semitoneFilterThreshold, setSemitoneFilterThreshold] = useState(
    SEMITONE_FILTER_THRESHOLD
  );
  const [octaveFilterThreshold, setOctaveFilterThreshold] = useState(
    OCTAVE_FILTER_THRESHOLD
  );
  const [rmsGate, setRmsGate] = useState(0.01);
  const [yinProbGate, setYinProbGate] = useState(0.4);
  const [processingBufferSize, setProcessingBufferSize] = useState(4096);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [showPitchWarning, setShowPitchWarning] = useState(false);
  const [pitchWarningText, setPitchWarningText] = useState("");
  const [nativeBounds, setNativeBounds] = useState({
    bufferMin: 512,
    bufferMax: 8192,
    bufferStep: 256,
    rmsMin: 0,
    rmsMax: 0.1,
    rmsStep: 0.001,
    yinMin: 0,
    yinMax: 1,
    yinStep: 0.01,
  });

   const [useDTWMode, setUseDTWMode] = useState(true); // true = DTW, false = Note-by-Note
  const useDTWModeRef = useRef(true); // Ref to access current mode in event handler
  const updateScheduled = useRef<boolean>(false);
  const latestBeat = useRef<number>(0);
  const lastDispatchedBeat = useRef<number | null>(null);

  // Keep ref in sync with state
  useEffect(() => {
    useDTWModeRef.current = useDTWMode;
  }, [useDTWMode]);

  useEffect(() => {
    const loadNativeBounds = async () => {
      if (!AudioPerformanceModule?.getProcessingConfigBounds) return;

      try {
        const bounds = await AudioPerformanceModule.getProcessingConfigBounds();
        setNativeBounds((prev) => ({
          ...prev,
          ...bounds,
        }));
      } catch (e) {
        console.warn("Failed to load native processing bounds; using defaults", e);
      }
    };

    loadNativeBounds();
  }, []);

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

  const showPitchWarningPopup = (message: string) => {
    const now = Date.now();
    if (now - lastPitchWarningRef.current < PITCH_WARNING_COOLDOWN_MS) return;

    lastPitchWarningRef.current = now;
    setPitchWarningText(message);
    setShowPitchWarning(true);

    if (pitchWarningTimeoutRef.current) {
      clearTimeout(pitchWarningTimeoutRef.current);
    }

    pitchWarningTimeoutRef.current = setTimeout(() => {
      setShowPitchWarning(false);
    }, PITCH_WARNING_DURATION_MS);
  };

  const recordPitchWarningSample = (intonation: number) => {
    if (Math.abs(intonation) <= ADVANCE_THRESHOLD) return;

    const buffer = pitchWarningBufferRef.current;
    buffer.push(intonation);
    if (buffer.length > PITCH_WARNING_WINDOW) buffer.shift();

    if (buffer.length < PITCH_WARNING_WINDOW) return;

    let highCount = 0;
    let lowCount = 0;
    for (const sample of buffer) {
      if (sample > ADVANCE_THRESHOLD) highCount++;
      if (sample < -ADVANCE_THRESHOLD) lowCount++;
    }

    if (highCount >= PITCH_WARNING_MIN) {
      showPitchWarningPopup("Lower your pitch");
    } else if (lowCount >= PITCH_WARNING_MIN) {
      showPitchWarningPopup("Raise your pitch");
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
      if (pitchWarningTimeoutRef.current) {
        clearTimeout(pitchWarningTimeoutRef.current);
        pitchWarningTimeoutRef.current = null;
      }
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
    const { refPosition, pitch, probability } = event;

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
      handleTimePitchUpdate(estTime, pitch, probability);
    } else {
      // Note-by-Note Mode: Use pitch-based advancement
      if (pitch > 0 && probability > 0.4) {
        handlePitchUpdate(pitch);
      }
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

  const resetPerformanceState = () => {
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

    resetPerformanceState();

    const base = score.replace(/\.musicxml$/, "");
    const csvUri = getScoreCSVData(base);
    const noteTable = await loadCsvInfo(csvUri);
    csvDataRef.current = noteTable;

    console.log("Isplaying=", state.playing, "\nDispatch start/stop");
    console.log("Mode:", useDTWMode ? "DTW" : "Note-by-Note");
    dispatch({ type: "start/stop" });
    setIsPaused(false);

    // Initialize native DTW with reference audio (only in DTW mode)
    if (useDTWMode) {
      if (lastInitializedScoreRef.current === base) {
        console.log("-- Score has not changed, fast resetting native DTW...");
        try {
          if (AudioPerformanceModule?.fastResetDTW) {
            await AudioPerformanceModule.fastResetDTW();
          }
        } catch (e) {
          console.warn("fastResetDTW failed, falling back to full initialization", e);
          const dtwInitialized = await initializeDTW(base);
          if (dtwInitialized) {
            lastInitializedScoreRef.current = base;
          }
        }
      } else {
        const dtwInitialized = await initializeDTW(base);
        if (dtwInitialized) {
          lastInitializedScoreRef.current = base;
        } else {
          console.warn(
            "DTW initialization failed - score following may not work correctly",
          );
        }
      }
    } else {
      console.log("Note-by-Note mode - skipping DTW initialization");
    }

    // Set audio processing parameters on native module
    await applyNativeProcessingConfig();

    // Start Native Audio Engine
    if (AudioPerformanceModule?.startProcessing) {
      await AudioPerformanceModule.startProcessing();
      setIsProcessing(true);
    }
  };

  const applyNativeProcessingConfig  = async () => {
    if (!AudioPerformanceModule?.setProcessingConfig) return

    try {
      await AudioPerformanceModule.setProcessingConfig(
        processingBufferSize,
        rmsGate,
        yinProbGate
      )
    } catch (e) {
      console.error("Failed to apply processing config to native module:", e);
    }
  }
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

    resetPerformanceState();

    await runPerformance();
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
      semitoneFilterThreshold,
      octaveFilterThreshold
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
    const newNoteColor = intonationToNoteColor(
      intonation,
      expNoteIndex,
      mistakeThreshold
    );

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
      recordPitchWarningSample(intonation);
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

  const handleTimePitchUpdate = (estTime: number, freq: number, probability: number) => {
    const noteTable: CSVRow[] = csvDataRef.current;
    if (!noteTable || expNoteIdxRef.current >= noteTable.length) return;

    const currentIndex = expNoteIdxRef.current;
    const targetNote = noteTable[currentIndex];

    // 1. Buffer pitch for current note
    if (freq > 0 && probability > 0.4) {
      const midi = hzToMidi(freq);
      const sampleIntonation = calculateSingleNoteIntonation(
        midi,
        targetNote.midi,
        semitoneFilterThreshold,
        octaveFilterThreshold
      );

      if (!Number.isNaN(sampleIntonation)) {
        // Median Buffering (same as Note-by-Note)
        const buffer = pitchBufferRef.current;
        buffer.push(sampleIntonation);
        if (buffer.length > 5) buffer.shift(); // Keep last 5 samples

        const intonation = listMedian(buffer);
        // Accumulate the robust intonation for the entire note
        noteMistakesRef.current.push(intonation);
        recordPitchWarningSample(intonation);
      }
    }

    // 2. Advance if estTime has reached the refTime of the NEXT note
    if (
      currentIndex + 1 < noteTable.length &&
      estTime >= noteTable[currentIndex + 1].refTime
    ) {
      // Color now-finished note based on aggregate
      const medianIntonation =
        noteMistakesRef.current.length > 0
          ? listMedian(noteMistakesRef.current)
          : 0;

      const noteColor = intonationToNoteColor(
        medianIntonation,
        currentIndex,
        mistakeThreshold
      );

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

      // Flush the buffers for the next note
      pitchBufferRef.current = [];
      noteMistakesRef.current = [];

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

  const handleModeChange = (value: boolean) => {
    setUseDTWMode(value);
    resetPerformanceState();
  };

  return (
    <View style={styles.container}>
      <Modal
        transparent
        visible={showPitchWarning}
        animationType="fade"
        statusBarTranslucent
      >
        <View style={styles.pitchWarningContainer} pointerEvents="none">
          <View style={styles.pitchWarningBox}>
            <Text style={styles.pitchWarningText}>{pitchWarningText}</Text>
          </View>
        </View>
      </Modal>
      {/* Advanced Audio Settings */}
      <TouchableOpacity
        style={styles.settingsHeader}
        onPress={() => setShowAdvancedSettings(!showAdvancedSettings)}
      >
        <Text style={styles.settingsTitle}>
          ⚙️ Audio Settings {showAdvancedSettings ? "▼" : "▶"}
        </Text>
      </TouchableOpacity>

      {showAdvancedSettings && (
        <View style={styles.settingsContainer}>
          {/* Mistake Threshold */}
          <View style={styles.sliderRow}>
            <View style={styles.sliderHeader}>
              <Text style={styles.sliderLabel}>Mistake Threshold</Text>
              <Text style={styles.sliderValue}>{mistakeThreshold.toFixed(2)}</Text>
            </View>
            <Slider
              style={styles.slider}
              minimumValue={MISTAKE_THRESHOLD_MIN}
              maximumValue={MISTAKE_THRESHOLD_MAX}
              step={MISTAKE_THRESHOLD_STEP}
              value={mistakeThreshold}
              onValueChange={setMistakeThreshold}
              minimumTrackTintColor="#2C3E50"
              maximumTrackTintColor="#BDC3C7"
              thumbTintColor="#2C3E50"
            />
          </View>

          {/* Semitone Filter Threshold */}
          <View style={styles.sliderRow}>
            <View style={styles.sliderHeader}>
              <Text style={styles.sliderLabel}>Semitone Filter</Text>
              <Text style={styles.sliderValue}>
                {semitoneFilterThreshold.toFixed(1)} st
              </Text>
            </View>
            <Slider
              style={styles.slider}
              minimumValue={SEMITONE_FILTER_THRESHOLD_MIN}
              maximumValue={SEMITONE_FILTER_THRESHOLD_MAX}
              step={SEMITONE_FILTER_THRESHOLD_STEP}
              value={semitoneFilterThreshold}
              onValueChange={setSemitoneFilterThreshold}
              minimumTrackTintColor="#2C3E50"
              maximumTrackTintColor="#BDC3C7"
              thumbTintColor="#2C3E50"
            />
          </View>

          {/* Octave Filter Threshold */}
          <View style={styles.sliderRow}>
            <View style={styles.sliderHeader}>
              <Text style={styles.sliderLabel}>Octave Filter</Text>
              <Text style={styles.sliderValue}>
                {octaveFilterThreshold.toFixed(0)} octaves
              </Text>
            </View>
            <Slider
              style={styles.slider}
              minimumValue={OCTAVE_FILTER_THRESHOLD_MIN}
              maximumValue={OCTAVE_FILTER_THRESHOLD_MAX}
              step={OCTAVE_FILTER_THRESHOLD_STEP}
              value={octaveFilterThreshold}
              onValueChange={setOctaveFilterThreshold}
              minimumTrackTintColor="#2C3E50"
              maximumTrackTintColor="#BDC3C7"
              thumbTintColor="#2C3E50"
            />
          </View>

          {/* RMS Gate (Native) */}
          <View style={styles.sliderRow}>
            <View style={styles.sliderHeader}>
              <Text style={styles.sliderLabel}>RMS Gate</Text>
              <Text style={styles.sliderValue}>{rmsGate.toFixed(3)}</Text>
            </View>
            <Slider
              style={styles.slider}
              minimumValue={nativeBounds.rmsMin}
              maximumValue={nativeBounds.rmsMax}
              step={nativeBounds.rmsStep}
              value={rmsGate}
              onValueChange={setRmsGate}
              minimumTrackTintColor="#2C3E50"
              maximumTrackTintColor="#BDC3C7"
              thumbTintColor="#2C3E50"
            />
          </View>

          {/* YIN Prob Gate (Native) */}
          <View style={styles.sliderRow}>
            <View style={styles.sliderHeader}>
              <Text style={styles.sliderLabel}>YIN Prob Gate</Text>
              <Text style={styles.sliderValue}>{yinProbGate.toFixed(2)}</Text>
            </View>
            <Slider
              style={styles.slider}
              minimumValue={nativeBounds.yinMin}
              maximumValue={nativeBounds.yinMax}
              step={nativeBounds.yinStep}
              value={yinProbGate}
              onValueChange={setYinProbGate}
              minimumTrackTintColor="#2C3E50"
              maximumTrackTintColor="#BDC3C7"
              thumbTintColor="#2C3E50"
            />
          </View>

          {/* Processing Buffer Size (Native) */}
          <View style={styles.sliderRow}>
            <View style={styles.sliderHeader}>
              <Text style={styles.sliderLabel}>Buffer Size</Text>
              <Text style={styles.sliderValue}>{processingBufferSize} samples</Text>
            </View>
            <Slider
              style={styles.slider}
              minimumValue={nativeBounds.bufferMin}
              maximumValue={nativeBounds.bufferMax}
              step={nativeBounds.bufferStep}
              value={processingBufferSize}
              onValueChange={setProcessingBufferSize}
              minimumTrackTintColor="#2C3E50"
              maximumTrackTintColor="#BDC3C7"
              thumbTintColor="#2C3E50"
            />
          </View>
        </View>
      )}

      {/* Show tempo of selected score to be played */}
      {bpm ? (
        <Text style={styles.tempoText}>Reference Tempo: {bpm} BPM</Text>
      ) : null}

      {/* Mode Toggle */}
      <View style={styles.modeToggleContainer}>
        <Text style={styles.modeLabel}>Note-by-Note</Text>
        <Switch
          value={useDTWMode}
          onValueChange={handleModeChange}
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
        onPress={() => {
          runPerformance();
        }}
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
  container: {
    position: "relative",
    flex: 1,
  },
  button: {
    padding: 12,
    backgroundColor: "#2C3E50",
    borderRadius: 8,
    alignItems: "center",
    marginBottom: 8,
  },
  buttonRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
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
    marginLeft: 8,
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
  settingsHeader: {
    padding: 12,
    backgroundColor: "#34495E",
    borderRadius: 8,
    marginBottom: 8,
  },
  settingsTitle: {
    color: "#FFF",
    fontSize: 14,
    fontWeight: "bold",
  },
  settingsContainer: {
    backgroundColor: "#ECF0F1",
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  sliderRow: {
    marginVertical: 10,
  },
  sliderHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  slider: {
    width: "100%",
    height: 40,
  },
  sliderValue: {
    fontSize: 12,
    color: "#34495E",
    fontVariant: ["tabular-nums"],
  },
  sliderLabel: {
    fontSize: 12,
    color: "#2C3E50",
    fontWeight: "500",
    flex: 1,
  },
  pitchWarningContainer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "flex-start",
    paddingTop: 12,
    zIndex: 9999,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 20,
  },
  pitchWarningBox: {
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  pitchWarningText: {
    color: "#FFF",
    fontSize: 12,
    fontWeight: "600",
  },
});
