import React, { useState, useRef, useEffect } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { Audio, AVPlaybackStatus } from "expo-av";

import { ScoreFollower } from "../audio/ScoreFollower";
import { CENSFeatures } from "../audio/FeaturesCENS";
import { FeaturesConstructor } from "../audio/Features";
import { Platform } from "react-native";
import { Asset } from "expo-asset";
import TempoGraph from "./TempoGraph";
import { prepareAudio, resampleAudio, toMono } from "../utils/audioUtils";
import {
  calculateWarpedTimes,
  computeOfflineAlignmentPath,
  precomputeAlignmentPath,
} from "../utils/alignmentUtils";
import {
  LiveFile,
  parseWebWavFile,
  pickMobileWavFile,
} from "../utils/fileSelectorUtils";
import { CSVRow, loadCsvInfo } from "../utils/csvParsingUtils";
import { 
  getScoreRefAudio, 
  getScoreCSVData,
  unifiedScoreMap 
} from "../score_name_to_data_map/unifiedScoreMap";

import { getCurrentUser, savePerformanceData, PerformanceData } from "../utils/accountUtils";
import { calculateIntonation, intonationToNoteColor, testIntonation } from "../audio/Intonation";
import { NoteColor } from "../utils/musicXmlUtils";

interface ScoreFollowerTestProps {
  score: string; // Selected score name
  dispatch: (action: { type: string; payload?: any }) => void; // Dispatch function used to update global state
  bpm?: number; // Optional BPM number,
  FeaturesCls?: FeaturesConstructor<any>;
  state: any;
}

export default function ScoreFollowerTest({
  score,
  dispatch,
  bpm = 100, // Default BPM if not provided in props
  FeaturesCls = CENSFeatures,
  state,
}: ScoreFollowerTestProps) {
  const [liveFile, setLiveFile] = useState<LiveFile | null>(null);
  const nextIndexRef = useRef<number>(0); // Track next CSV index to dispatch
  const soundRef = useRef<Audio.Sound | null>(null); // Reference to Audio Component
  const followerRef = useRef<ScoreFollower | null>(null); // Reference to score follower instance
  const webViewRef = useRef<any>(null);
  const audioDataRef = useRef<Float32Array>(new Float32Array()); // Reference to decoded audio sample data
  const pathRef = useRef<[number, number][]>([]); // Reference to alignment path
  const inputRef = useRef<HTMLInputElement>(null); // Reference to the file select HTML element
  const frameSecRef = useRef<number>(0); // Reference to duration of each frame in seconds
  const csvDataRef = useRef<CSVRow[]>([]); // Array that contains CSV rows (CSV row == info on a note in a selected score)
  const [warpingPath, setWarpingPath] = useState<[number, number][]>([]); // State to store warping path when computed
  const [frameSize, setFrameSize] = useState<number>(0); // State to store frame size of score follower
  const [sampleRate, setSampleRate] = useState<number>(0); // State to store sample rate of score follower
  const [performanceComplete, setPerformanceComplete] = useState(false); // State to determine if plackback of a score is finished or not
  const [performanceSaved, setPerformanceSaved] = useState(false); // State to track if performance has been saved
  const [isPaused, setIsPaused] = useState(false);
  const isWeb = Platform.OS === "web"; // Boolean indicating if user is on website version or not
  const dispatchSequenceRef = useRef<number>(0);

  // Unload the sound when the component unmounts to free up memory
  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync().catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    console.log('[ScoreFollowerTest] Score changed to:', score);
    
    if (soundRef.current) {
      soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
    }
    
    setLiveFile(null);
    
    setPerformanceComplete(false);
    setPerformanceSaved(false);
    
    nextIndexRef.current = 0;
    followerRef.current = null;
    audioDataRef.current = new Float32Array();
    pathRef.current = [];
    csvDataRef.current = [];
  }, [score]);

  // Web versin of wav file upload
  function onWebChange(e: React.ChangeEvent<HTMLInputElement>) {
    console.log("Web file input changed", e);
    const file = parseWebWavFile(e);
    setLiveFile(file);

    // Allow re-selecting the same file by clearing the input value
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }
  // Mobile version of wav file upload using DocumentPicker
  async function onMobilePress() {
    const file = await pickMobileWavFile();
    setLiveFile(file);
  }

  const runIntonation = async () => {
    // const audioUri = "/schumann_melodyVLCduet/baseline/instrument_0.wav";
    // const csvUri = "/schumann_melodyVLCduet/baseline/schumann_melody_4sec.csv";

    const audioUri = "/air_on_the_g_string/baseline/instrument_0.wav";
    const csvUri = "/air_on_the_g_string/baseline/aotgs_solo_100bpm.csv";

    await testIntonation(audioUri, csvUri, 44100);
  };

  const saveCurrentPerformance = async () => {
    const user = await getCurrentUser();
    if (!user) {
      console.log('No user logged in');
      alert('Please log in to save performance data');
      return;
    }

    const performanceData: PerformanceData = {
      id: Date.now().toString(),
      scoreName: score || 'unknown',
      timestamp: new Date().toISOString(),
      intonationData: csvDataRef.current.map(row => row.intonation || 0),
      csvData: csvDataRef.current,
      warpingPath: pathRef.current,
      tempo: bpm,
    };

    await savePerformanceData(performanceData);
    setPerformanceSaved(true);
    console.log('Performance saved successfully');
    alert('Performance saved successfully!');
  };

  const resetCursorToStart = () => {
    dispatch({ type: "SET_ESTIMATED_BEAT", payload: 0 });
  };

  const handlePlaybackStatusUpdate = (status: AVPlaybackStatus) => {
    if (!status.isLoaded) return;

    const currentTimeSec = status.positionMillis / 1000;

    if (status.isPlaying) {
      while (
        nextIndexRef.current < csvDataRef.current.length &&
        currentTimeSec >= csvDataRef.current[nextIndexRef.current].predictedTime
      ) {
        const beat = csvDataRef.current[nextIndexRef.current].beat;
        const predictedTime = csvDataRef.current[nextIndexRef.current].predictedTime;
        console.log(`Audio time: ${currentTimeSec.toFixed(3)}s, Note time: ${predictedTime.toFixed(3)}s, Beat: ${beat}`);
        nextIndexRef.current++;

        // Unified cursor control via state dispatch
        // Pass audioTime for lag analysis logging
        dispatch({ type: "SET_ESTIMATED_BEAT", payload: beat, audioTime: currentTimeSec } as any);
      }
    }

    if (status.didJustFinish) {
      dispatch({ type: "start/stop" }); // Toggle "playing" boolean (to false in this case)
      dispatch({ type: "SET_NOTE_COLORS", payload: [] });
      setPerformanceComplete(true); // Toggle performanceComplete boolean to true
      setIsPaused(false);
      nextIndexRef.current = 0; // Reset index ref so we can play again
      soundRef.current?.setOnPlaybackStatusUpdate(null); // Stop listening for playback updates

      console.log('[Performance End] Cursor reset triggered');

      // Reset cursor by setting beat to 0 after a short delay to ensure all other state updates complete
      setTimeout(() => {
        resetCursorToStart();
      }, 100);
    }
  };

  const createSoundAndPlay = async () => {
    if (!liveFile) return;

    const soundSource = { uri: liveFile.uri };
    const { sound } = await Audio.Sound.createAsync(
      soundSource,
      {
        shouldPlay: true,
        progressUpdateIntervalMillis: 10,
      },
      handlePlaybackStatusUpdate,
    );
    soundRef.current = sound;
  };

  const runFollower = async () => {
    if (!score) return; // Do nothing if no score is selected

    const base = score.replace(/\.musicxml$/, ""); // Retrieve score name (".musicxml" removal)
    setPerformanceSaved(false); // Reset saved state when starting new performance
    setIsPaused(false);

    if (soundRef.current) {
      try {
        soundRef.current.setOnPlaybackStatusUpdate(null);
        await soundRef.current.stopAsync();
        await soundRef.current.unloadAsync();
      } catch {
        // Ignore cleanup errors
      }
      soundRef.current = null;
    }
    nextIndexRef.current = 0;
    resetCursorToStart();
    dispatch({ type: "SET_NOTE_COLORS", payload: [] });

    // These booleans are mainly used to disable certain features at certain times
    dispatch({ type: "start/stop" }); // Toggle playing boolean (to true in this case)
    dispatch({ type: "toggle_loading_performance" }); // Toggle loading boolean (to true in this case)
    setPerformanceComplete(false); // Set performance complete boolean to false

    try {
      // Use unified mapping for cross-platform file access
      const refUri = getScoreRefAudio(base);

      console.log("-- Creating ScoreFollower...");
      followerRef.current = await ScoreFollower.create(refUri, FeaturesCls); // Initialize score follower instance (default parameters from ScoreFollower.tsx)
      console.log("-- ScoreFollower created");

      const follower = followerRef.current!;
      const refFeatures = follower.ref.featuregram; // Get reference features from follower instance

      // Extract and set sample rate and window length from the ScoreFollower instance
      const { sr, winLen } = follower;
      setSampleRate(sr);
      setFrameSize(winLen);

      const frameSize = winLen; // Set framesize to window length property of scorefollower
      const sampleRate = sr; // Set sampleRate property of scorefollower
      frameSecRef.current = frameSize / sampleRate; // Duration of each frame in seconds

      const audioData = await prepareAudio(liveFile.uri, sampleRate);

      audioDataRef.current = audioData;
      console.log("-- Audio data prepared, length=", audioData.length);

      console.log("-- Computing alignment path...");
      console.log("   Live audio URI:", liveFile.uri);
      console.log("   Ref audio URI:", refUri);
      pathRef.current = precomputeAlignmentPath(audioData, frameSize, follower); // Compute alignment path
      console.log("-- Alignment path length=", pathRef.current.length);

      // const rawPath = computeOfflineAlignmentPath(refFeatures, audioDataRef.current, FeaturesCls, sr, winLen)
      // console.log("raw path: ", rawPath) // Just print to console log for now

      // downloadFullPCM(audioDataRef.current)

      {
        console.log("-- precompute CSV block: score=", score, "→ base=", base);
        // Use unified mapping for CSV file access
        const csvUri = getScoreCSVData(base);
        console.log("-- CSV URI =", csvUri);

        console.log("-- Calling loadCsvInfo(csvUri, isWeb=", isWeb, ")…");
        const rows = await loadCsvInfo(csvUri); // Obtain rarray of csv rows (info on each note of score such as beat value, ref time when note is played, etc.)
        console.log("-- Loaded CSV rows count =", rows.length);

        csvDataRef.current = rows; // Save the parsed CSV rows for downstream use

        const stepSize = frameSecRef.current; // Duration of each frame in seconds
        const warpingPath = pathRef.current; // The Dynamic Time Warping path: an array of [referenceIndex, liveIndex] pairs
        const refTimes = csvDataRef.current.map((r) => r.refTime); // Pull out just the reference times from each row to feed into the calculateWarpedTimes()

        const predictedTimes = calculateWarpedTimes(
          // Obtain array of ESTIMATED timestamps of when each note is played in the live audio
          warpingPath,
          stepSize,
          refTimes,
          true,
          false
        );

        console.log("Perfect timestamps mode enabled - using refTimes directly");
        console.log("Expected result: cursor should move in perfect sync with audio");
        console.log("Sample refTimes:", refTimes.slice(0, 5));
        console.log("Sample predictedTimes:", predictedTimes.slice(0, 5));
        console.log("Are they identical?", JSON.stringify(refTimes.slice(0, 5)) === JSON.stringify(predictedTimes.slice(0, 5)));

        // Update CSV struct arr with predicted live times for each note
        csvDataRef.current = csvDataRef.current.map((row, i) => ({
          ...row,
          predictedTime: predictedTimes[i],
        }));

        //console.log("New table", csvDataRef.current);

        console.log("Using perfect timestamps (refTimes directly)");
        const timingComparison1 = csvDataRef.current.slice(0, 10).map(row => ({
          beat: row.beat,
          refTime: row.refTime,
          predictedTime: row.predictedTime,
          difference: row.predictedTime - row.refTime,
        }));
        console.log("Perfect timing comparison:", timingComparison1);

        console.log("New table with predicted times:", csvDataRef.current.slice(0, 10)); 
        console.log("=== TIMING ANALYSIS ===");
        console.log("Step size (frame duration):", stepSize, "seconds");
        console.log("Warping path length:", warpingPath.length);
        console.log("Sample warping path entries:", warpingPath.slice(0, 5));
        console.log("Sample predicted times:", predictedTimes.slice(0, 10));
        console.log("Sample reference times:", refTimes.slice(0, 10));
        const timingDiffs1 = predictedTimes.map((predTime, i) => ({
          noteIndex: i,
          refTime: refTimes[i],
          predictedTime: predTime,
          difference: predTime - refTimes[i],
          beat: csvDataRef.current[i]?.beat
        }));
        console.log("Timing differences (predicted - reference):", timingDiffs1.slice(0, 10));


        console.log("Using perfect timestamps (refTimes directly)");
        const timingComparison2 = csvDataRef.current.slice(0, 10).map(row => ({
          beat: row.beat,
          refTime: row.refTime,
          predictedTime: row.predictedTime,
          difference: row.predictedTime - row.refTime,
        }));
        console.log("Perfect timing comparison:", timingComparison2);

        console.log("New table with predicted times:", csvDataRef.current.slice(0, 10)); 
        console.log("=== TIMING ANALYSIS ===");
        console.log("Step size (frame duration):", stepSize, "seconds");
        console.log("Warping path length:", warpingPath.length);
        console.log("Sample warping path entries:", warpingPath.slice(0, 5));
        console.log("Sample predicted times:", predictedTimes.slice(0, 10));
        console.log("Sample reference times:", refTimes.slice(0, 10));
        const timingDiffs2 = predictedTimes.map((predTime, i) => ({
          noteIndex: i,
          refTime: refTimes[i],
          predictedTime: predTime,
          difference: predTime - refTimes[i],
          beat: csvDataRef.current[i]?.beat
        }));
        console.log("Timing differences (predicted - reference):", timingDiffs2.slice(0, 10));


        const scorePitchesCol = csvDataRef.current.map((r) => r.midi);
        const intonationParams = [1024, 512];
        const intonation = calculateIntonation(
          audioData,
          scorePitchesCol,
          predictedTimes,
          sr,
          intonationParams[0],
          intonationParams[1],
        );

        // Debug sequence: tiled flat-neutral-sharp
        // let debugTmp = intonation;
        // debugTmp = debugTmp.map( (el, idx) => (idx % 3) - 1);

        // console.log("Debug tmp", debugTmp);
        // dispatch({
        //   type: "SET_NOTE_COLORS",
        //   payload: intonationToColors(debugTmp)
        // });

        // Update CSV struct arr with intonation values for each note
        csvDataRef.current = csvDataRef.current.map((row, i) => ({
          ...row,
          intonation: intonation[i],
        }));

        const newTable = csvDataRef.current.map((row, i) => ({
          time: row.refTime,
          midi: row.midi,
          intonation: intonation[i],
        }));

        console.log(`New table with (win, hop) (${intonationParams}):`, newTable);
      }

      console.log(pathRef.current); // Show full path
      setWarpingPath(pathRef.current); // Save warping path in local "warpingPath" state

      dispatch({ type: "toggle_loading_performance" }); // Toggle loading boolean (to false in this case)

      // Create and load the sound object from the live audio URI
      await createSoundAndPlay();
    } catch (err) {
      console.error("ScoreFollower Error:", err);
      dispatch({ type: "start/stop" });
    }
  };

  const togglePause = async (doPause = null) => {
    console.log("[Toggle Pause] isPaused =", isPaused, doPause);
    if (!soundRef.current) return;

    try {
      const status = await soundRef.current.getStatusAsync();
      if (!status.isLoaded) return;

      if (status.isPlaying || doPause === true) {
        await soundRef.current.pauseAsync();
        setIsPaused(true);
      } else {
        await soundRef.current.playAsync();
        setIsPaused(false);
      }
    } catch (err) {
      console.error("Pause/Resume Error:", err);
    }
  };

  const restartPlayback = async () => {
    await togglePause(true); // Ensure playback is paused before restarting

    if (!liveFile) return;

    if (state.playing) {
      dispatch({ type: "start/stop" }); // flip playing off so runFollower can toggle it on again
    }

    try {
      if (soundRef.current) {
        const status = await soundRef.current.getStatusAsync();
        if (status.isLoaded) {
          await soundRef.current.stopAsync();
        }
        await soundRef.current.unloadAsync();
      }
    } catch (err) {
      console.error("Restart Error:", err);
    } finally {
      soundRef.current = null;
    }

    await runFollower();
  };

  return (
    <View>
      {/* Test intonation Performance button */}
      <TouchableOpacity style={[styles.button]} onPress={runIntonation}>
        <Text style={styles.buttonText}>{"Test intonation"}</Text>
      </TouchableOpacity>
      {/* End test intonation button */}

      {/* Show tempo of selected score to be played */}
      {bpm ? (
        <Text style={styles.tempoText}>Reference Tempo: {bpm} BPM</Text>
      ) : null}

      <View style={styles.row}>
        {/* Web version of wav file upload */}
        <View style={styles.pickerContainer}>
          {Platform.OS === "web" ? (
            <>
              <input
                ref={inputRef}
                type="file"
                accept=".wav"
                style={styles.hiddenInput}
                disabled={state.playing}
                onChange={onWebChange}
              />
              <TouchableOpacity
                style={[
                  styles.fileButton,
                  state.playing && styles.disabledButton,
                ]}
                onPress={() => {
                  if (inputRef.current) {
                    inputRef.current.value = "";
                    inputRef.current.click();
                  }
                }}
                disabled={state.playing}
              >
                {/* Display wav file name on button */}
                <Text
                  style={styles.buttonText}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {liveFile
                    ? `Selected: ${liveFile.name}`
                    : "Upload a Performance"}
                </Text>
              </TouchableOpacity>
            </>
          ) : (
            /* Mobile version of wav file upload */
            <TouchableOpacity
              style={[
                styles.fileButton,
                state.playing && styles.disabledButton,
              ]}
              onPress={onMobilePress}
              disabled={state.playing}
            >
              {/* Display wav file name on button */}
              <Text
                style={styles.buttonText}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {liveFile ? `Selected: ${liveFile.name}` : "Select WAV File"}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Display Tempo Graph button */}
        <View style={styles.graphContainer}>
          <TempoGraph
            refTempo={bpm} // Pass in ref tempo of score for calculation
            beatsPerMeasure={state.beatsPerMeasure} // Pass in global beatPerMeasure state for calculation
            warpingPath={warpingPath} // Pass in computed warping path for calculation
            scoreName={score.replace(/\.musicxml$/, "")} // Selected score name
            disabled={!performanceComplete || liveFile == null} // Disable if we are in a performance or no wav file was uploaded
            frameSize={frameSize} // Pass frame size for calculation
            sampleRate={sampleRate} // Pass in sample rate for calculation
          />
        </View>
      </View>

      {/* Start Performance button */}
      <TouchableOpacity
        style={[
          styles.button,
          (state.score === "" || state.playing || !liveFile) &&
            styles.disabledButton,
        ]}
        onPress={runFollower}
        disabled={state.score === "" || state.playing || !liveFile} // Disabled when no score is selected or already playing performance or no uploaded wav file
      >
        <Text style={styles.buttonText}>
          {state.playing ? "Running..." : "Play"}
        </Text>
      </TouchableOpacity>

        {/* Pause/Resume + Restart buttons */}
        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[
              styles.button,
              styles.halfButton,
              styles.pauseButton,
              (!state.playing && !isPaused) && styles.disabledButton,
            ]}
            onPress={togglePause}
            disabled={!state.playing && !isPaused}
          >
            <Text style={styles.buttonText}>
              {isPaused ? "Resume" : "Pause"}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.button,
              styles.halfButton,
              styles.lastHalfButton,
              styles.restartButton,
              (!liveFile || (!state.playing && !performanceComplete && !isPaused)) &&
                styles.disabledButton,
            ]}
            onPress={restartPlayback}
            disabled={!liveFile || (!state.playing && !performanceComplete && !isPaused)}
          >
            <Text style={styles.buttonText}>Restart</Text>
          </TouchableOpacity>
        </View>

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
