import { PitchDetector } from "pitchy";
import { CSVRow, loadCsvInfo } from "../utils/csvParsingUtils";
import { prepareAudio } from "../utils/audioUtils";
import { NoteColor } from "../utils/musicXmlUtils";

export const OCTAVE_OFF_THRESHOLD = 2;
export const SEMITONE_THRESHOLD = 2;

const AGGREGATE_DIVISOR = 1.1;
const AGGREGATE_DEFAULT_SIZE = 10;

export const COLOR_NEUTRAL = "#000000";
export const COLOR_SHARP = "#00ff00"
export const COLOR_FLAT = "#ff0000";

export const MISTAKE_THRESHOLD = 0.5;

function windowNumPerTs(
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

function listMedian(numbers: number[]): number | null {
  if (numbers.length === 0) return null;

  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  } else {
    return sorted[mid];
  }
}

function hzToMidi(frequency: number): number {
  if (frequency < 0) {
    throw new Error(`Frequency must be a nonnegative number: ${frequency}`);
  }

  const midi = 69 + 12 * Math.log2(frequency / 440);
  return midi;
}

function calculateF0s(
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

    const [mcleodFrequency, mcleodFrequencyClarity] = mcleod.findPitch(
      window,
      sampleRate,
    );
    f0s.push(mcleodFrequency);
  }

  return f0s;
}

function estimatePitchesAtTimestamps(
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
  const _windowNums = windowNumPerTs(
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
    let diffAggregate = rawAggregate.map((candidate) => {
      if (isNaN(candidate)) return undefined;

      let diff = candidate - scorePitch;
      if (Math.abs(diff) > 12) {
        if (Math.floor(diff / 12) > OCTAVE_OFF_THRESHOLD) return undefined;
        diff = diff % 12;
      }

      if (Math.abs(diff) > SEMITONE_THRESHOLD) return undefined;
      return diff;
    });

    diffAggregate = diffAggregate.filter((element) => element !== undefined);
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

export function calculateIntonation(
  audioSamples: Float32Array,
  scorePitchesCol: number[], // midi column of csv
  audioTimesCol: number[], // warped timestamps (or ref_ts column of csv for testing)
  sampleRate: number,
  winLen: number,
  hopLen: number = winLen,
) {
  console.log("-- Calculating Intonation")
  const audioF0s = calculateF0s(audioSamples, sampleRate, winLen, hopLen);
  const audioPitches = audioF0s.map((frq) => hzToMidi(frq));
  
  console.log("-- Calculating Intonation: got", audioF0s.length, "windows");
  return estimatePitchesAtTimestamps(
    audioTimesCol,
    scorePitchesCol,
    audioPitches,
    sampleRate,
    hopLen,
    false,
  );
}

export async function testIntonation(
  audioUri: string,
  tableUri: string,
  sr: number = 44100,
) {
  const audioData = await prepareAudio(audioUri, sr);
  const table: CSVRow[] = await loadCsvInfo(tableUri);

  const timeColname = "ref_ts"; // Assume csv treats input audio as ref
  if (!table[0][timeColname]) {
    console.error("No timestamp column in table with name", timeColname);
  }

  const scorePitchesCol = table.map((r) => r.midi);
  const audioTimesCol = table.map((r) => r[timeColname]);

  const intonationParams = [1024, 512];
  const intonation = calculateIntonation(
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

export function intonationToNoteColor(intonation: number, noteIdx: number) {
  let color: string;
  if (Math.abs(intonation) < MISTAKE_THRESHOLD) {
    color = COLOR_NEUTRAL;
  } else if (intonation > 0) {
    color = COLOR_SHARP;
  } else {
    color = COLOR_FLAT;
  }

  return { index: noteIdx, color: color };
}