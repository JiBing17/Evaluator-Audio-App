import { PitchDetector } from "pitchy";
import { CSVRow, loadCsvInfo } from "../utils/csvParsingUtils";
import { prepareAudio } from "../utils/audioUtils";
import { NoteColor } from "../utils/musicXmlUtils";
import { NativeModules, Platform } from "react-native";

export const MISTAKE_THRESHOLD = 0.5;
export const SEMITONE_FILTER_THRESHOLD = 6;
export const OCTAVE_FILTER_THRESHOLD = 2;
export const MISTAKE_THRESHOLD_MIN = 0;
export const MISTAKE_THRESHOLD_MAX = 2;
export const MISTAKE_THRESHOLD_STEP = 0.01;
export const SEMITONE_FILTER_THRESHOLD_MIN = 0;
export const SEMITONE_FILTER_THRESHOLD_MAX = 12;
export const SEMITONE_FILTER_THRESHOLD_STEP = 0.1;
export const OCTAVE_FILTER_THRESHOLD_MIN = 0;
export const OCTAVE_FILTER_THRESHOLD_MAX = 5;
export const OCTAVE_FILTER_THRESHOLD_STEP = 1;
export const COLOR_NEUTRAL = "#000000";
export const COLOR_SHARP = "#00ff00";
export const COLOR_FLAT = "#ff0000";

const AGGREGATE_DIVISOR = 1.1;
const AGGREGATE_DEFAULT_SIZE = 10;

let PitchDetectionModule: any;
if (Platform.OS === "android") {
  try {
    PitchDetectionModule = NativeModules.PitchDetectionModule;
  } catch (e) {
    console.log("Failed to load PitchDetectionModule: ", e);
  }
}

export function calculateSingleNoteIntonation(
  detectedMidi: number,
  scoreMidi: number,
  semitoneThreshold: number = SEMITONE_FILTER_THRESHOLD,
  octaveThreshold: number = OCTAVE_FILTER_THRESHOLD
): number {
  if (Number.isNaN(detectedMidi)) return NaN;
  
    const diff = detectedMidi - scoreMidi;
    const octavesCorrected = Math.round(diff / 12);
    const intonation = diff + (octavesCorrected * -12);
   
    if (Math.abs(octavesCorrected) > octaveThreshold) {
      // console.log("[DEBUG] Octave filter", octavesCorrected);
      return NaN;
    };
    if (Math.abs(intonation) > semitoneThreshold) {
      // console.log("[DEBUG] Semitone filter", intonation);
      return NaN;
    }
    return intonation;
}

export function intonationToNoteColor(
  intonation: number,
  noteIdx: number,
  mistakeThreshold: number = MISTAKE_THRESHOLD
): NoteColor {
  let color: string;
  if (Math.abs(intonation) < mistakeThreshold) {
    color = COLOR_NEUTRAL;
  } else if (intonation > 0) {
    color = COLOR_SHARP;
  } else {
    color = COLOR_FLAT;
  }

  return { index: noteIdx, color: color };
}

export function hzToMidi(frequency: number): number {
  if (frequency < 0) {
    console.log(`Frequency must be a nonnegative number: ${frequency}`);
    return NaN;
  }

  const midi = 69 + 12 * Math.log2(frequency / 440);
  return midi;
}

export function listMedian(numbers: number[]): number {
  if (numbers.length === 0) return 0;

  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  } else {
    return sorted[mid];
  }
}

export async function calculateIntonation(
  audioSamples: Float32Array,
  scorePitchesCol: number[], // midi column of csv
  audioTimesCol: number[], // warped timestamps (or ref_ts column of csv for testing)
  sampleRate: number,
  winLen: number,
  hopLen: number = winLen,
) {
  console.log("-- Calculating Intonation");
  const audioF0s = await _calculateF0s(audioSamples, sampleRate, winLen, hopLen);
  const audioPitches = audioF0s.map((frq) => hzToMidi(frq));

  console.log("-- Calculating Intonation: got", audioF0s.length, "windows");
  return _estimatePitchesAtTimestamps(
    audioTimesCol,
    scorePitchesCol,
    audioPitches,
    sampleRate,
    hopLen,
    false,
  );
}

function _windowNumPerTs(
  timestamps: number[],
  lastWindow: number,
  sampleRate: number,
  hopLength: number,
): number[] {
  return timestamps.map((ts) => {
    const windowNum = Math.floor((ts * sampleRate) / hopLength);
    if (windowNum > lastWindow) {
      console.error(
        `Given timestamp ${ts}s -> ${windowNum} is beyond audio length (last window ${lastWindow})`,
      );
    }

    return windowNum;
  });
} 

async function _calculateF0s(
  audioSamples: Float32Array,
  sampleRate: number,
  winLen: number,
  hopLen: number = winLen,
) {
  const mcleod = PitchDetector.forFloat32Array(winLen);

  let numWins = Math.floor((audioSamples.length - winLen) / hopLen) + 1;
  if (numWins < 0) numWins = 0;
  console.log(`${audioSamples.length} -> ${numWins}`);

  const f0s: number[] = [];
  for (let m = 0; m < numWins; m++) {
    const position = m * hopLen;
    const window = audioSamples.slice(position, position + winLen);

    if (Platform.OS === "android") {
      try {
        const detectedFrequency = await PitchDetectionModule.getPitch(
          sampleRate,
          Array.from(window),
        );

        f0s.push(detectedFrequency === -1 ? NaN : detectedFrequency);
      } catch (e) {
        console.error(
          "Android native pitch detection failed, falling back to JS library",
          e,
        );

        const [detectedFrequency, detectedFrequencyClarity] = mcleod.findPitch(
          window,
          sampleRate,
        );
        f0s.push(detectedFrequency);
      }
    } else {
      const [detectedFrequency, detectedFrequencyClarity] = mcleod.findPitch(
        window,
        sampleRate,
      );
      f0s.push(detectedFrequency);
    }
  }

  return f0s;
}

function _estimatePitchesAtTimestamps(
  timestampCol: number[],
  scorePitchCol: number[],
  audioPitches: number[],
  sampleRate: number,
  hopLength: number,
  logging: boolean,
) {
  console.log(
    `Audio length: ${audioPitches.length} windows, ~${(audioPitches.length * hopLength) / sampleRate}s?`,
  );

  // Convert timestamp -> sample no., sample no. -> window no. using hop len
  const lastWindow = audioPitches.length - 1;
  const _windowNums = _windowNumPerTs(
    timestampCol,
    lastWindow,
    sampleRate,
    hopLength,
  );

  if (logging) console.log("Window no. per timestamp:", _windowNums);

  const _aggregateSizes = _windowNums.map((windowNum, idx) => {
    let aggregateSize = AGGREGATE_DEFAULT_SIZE;

    const maxIdx = _windowNums.length - 1;
    if (idx < maxIdx) {
      let winsTillNextTs = _windowNums[idx + 1] - _windowNums[idx];
      aggregateSize = Math.floor(winsTillNextTs / AGGREGATE_DIVISOR);
    }

    aggregateSize = Math.min(
      aggregateSize,
      audioPitches.length - windowNum - 1,
    );

    if (aggregateSize < 0) {
      console.log("Invalid aggregate size; timestamps beyond audio length?");
      console.log(
        aggregateSize,
        windowNum,
        _windowNums[idx],
        _windowNums[idx + 1],
      );
      console.log(audioPitches.length, windowNum);
    }

    return aggregateSize;
  });

  const pitchEstimates = _windowNums.map((windowNum, idx) => {
    const directPitch = audioPitches[windowNum];
    const scorePitch = scorePitchCol[idx];
    const aggregateSize = _aggregateSizes[idx];

    const rawAggregate = audioPitches.slice(
      windowNum,
      windowNum + aggregateSize,
    );
    let diffAggregate = rawAggregate.map((candidate) => calculateSingleNoteIntonation(candidate, scorePitch));

    diffAggregate = diffAggregate.filter((element) => !Number.isNaN(element));
    const intonationDiff = listMedian(diffAggregate);
    const pitchEstimate = scorePitch + listMedian(diffAggregate);

    if (logging) {
      console.log(
        `Pitch #${idx}: Window num: ${windowNum} -> Direct Pitch: ${directPitch}`,
        // console.log(`Median ${pitchEstimate}, Aggr ${diffAggregate}`);
      );
      console.log(`... Aggregate length ${aggregateSize}`);
      console.log(`Score Pitch: `, scorePitch);
    }

    return intonationDiff;
    // return pitchEstimate;
  });

  return pitchEstimates;
}

export async function testIntonation(
  audioUri: string,
  tableUri: string,
  sr: number = 44100,
) {
  console.log("-- Test intonation: load audio", audioUri)
  const audioData = await prepareAudio(audioUri, sr);
  const table: CSVRow[] = await loadCsvInfo(tableUri);

  const timeColname = "ref_ts"; // Assume csv treats input audio as ref
  if (!table[0][timeColname]) {
    console.error("No timestamp column in table with name", timeColname);
  }

  const scorePitchesCol = table.map((r) => r.midi);
  const audioTimesCol = table.map((r) => r[timeColname]);

  const intonationParams = [1024, 512];
  const intonation = await calculateIntonation(
    audioData,
    scorePitchesCol,
    audioTimesCol,
    sr,
    intonationParams[0],
    intonationParams[1],
  );

  const newTable = table.map((row, i) => ({
    time: row.refTime,
    midi: row.midi,
    intonation: intonation[i],
  }));

  console.log(`New table with (win, hop) (${intonationParams}):`, newTable);

  return intonation;
}