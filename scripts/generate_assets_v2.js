const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SRC_DIR = path.join(__dirname, '..', 'src');
const SCORE_MAPS_DIR = path.join(SRC_DIR, 'score_name_to_data_map');

const WAV_EXTENSIONS = ['.wav'];
const MIDI_EXTENSIONS = ['.mid', '.midi'];
const CSV_EXTENSIONS = ['.csv'];
const MUSICXML_EXTENSIONS = ['.musicxml'];

function findFileByExtension(piecePath, extensions) {
  const matches = fs.readdirSync(piecePath)
    .filter(file => extensions.some(ext => file.toLowerCase().endsWith(ext)))
    .sort();

  if (matches.length === 0) {
    return null;
  }

  if (matches.length > 1) {
    console.warn(`Multiple files found for ${piecePath}: ${matches.join(', ')}`);
  }

  return matches[0];
}

/**
 * Builds mappings of piece names to their corresponding asset paths and content.
 * public
 *  - piece1
 *    - piece1.wav
 *    - piece1.csv
 *    - piece1.musicxml
 *    - piece1.mid/midi
 */
function buildMappings() {
  console.log('Scanning public directory:', PUBLIC_DIR);

  if (!fs.existsSync(PUBLIC_DIR)) {
    console.error('Public directory not found:', PUBLIC_DIR);
    process.exit(1);
  }

  const pieceNames = fs.readdirSync(PUBLIC_DIR)
    .filter(name => {
      if (name !== "air_on_the_g_string") {
        console.warn(`Skipping ${name} - not in the list of expected pieces`);
        return false;
      }
      const fullPath = path.join(PUBLIC_DIR, name);
      return fs.statSync(fullPath).isDirectory() && !name.startsWith('.');
    });
  const errors = [];

  const wavMap = {};
  const csvMap = {};
  const midiMap = {};
  const musicxmlMap = {};

  pieceNames.forEach(pieceName => {
    const piecePath = path.join(PUBLIC_DIR, pieceName);

    const wavFile = findFileByExtension(piecePath, WAV_EXTENSIONS);
    const midiFile = findFileByExtension(piecePath, MIDI_EXTENSIONS);
    const csvFile = findFileByExtension(piecePath, CSV_EXTENSIONS);
    const musicxmlFile = findFileByExtension(piecePath, MUSICXML_EXTENSIONS);

    const missing = [];
    if (!wavFile) missing.push('wav');
    if (!midiFile) missing.push('midi');
    if (!csvFile) missing.push('csv');
    if (!musicxmlFile) missing.push('musicxml');

    if (missing.length > 0) {
      errors.push({ pieceName, missing });
      console.warn(`${pieceName}: Missing ${missing.join(', ')}`);
      return;
    }

    // Use piece name as key for wav and csv
    // but use musicxml file name as key for midi and musicxml maps
    wavMap[pieceName] = `/${pieceName}/${wavFile}`;
    csvMap[pieceName] = `/${pieceName}/${csvFile}`;
    midiMap[musicxmlFile] = `/${pieceName}/${midiFile}`;

    const xmlPath = path.join(piecePath, musicxmlFile);
    const xmlContent = fs.readFileSync(xmlPath, 'utf8');
    musicxmlMap[musicxmlFile] = xmlContent;
  });

  return { wavMap, csvMap, midiMap, musicxmlMap, errors };
}

function writeScoreToWavMap(wavMap) {
  const entries = Object.entries(wavMap)
    .map(([key, value]) => `  "${key}": "${value}"`)
    .join(',\n');

  const content = `// AUTO GENERATED FILE\n`
    + `export const wavAssetMap: Record<string, string> = {\n${entries}\n};\n\n`
    + `export default wavAssetMap;\n`;

  fs.writeFileSync(path.join(SCORE_MAPS_DIR, 'scoreToWavMap.ts'), content);
}

function writeScoreToCsvMap(csvMap) {
  const entries = Object.entries(csvMap)
    .map(([key, value]) => `  "${key}": "${value}"`)
    .join(',\n');

  const content = `// AUTO GENERATED FILE\n`
    + `export const csvAssetMap: Record<string, string> = {\n${entries}\n};\n\n`
    + `export default csvAssetMap;\n`;

  fs.writeFileSync(path.join(SCORE_MAPS_DIR, 'scoreToCsvMap.ts'), content);
}

function writeScoreToMidiMap(midiMap) {
  const entries = Object.entries(midiMap)
    .map(([key, value]) => `  "${key}": "${value}"`)
    .join(',\n');

  const content = `// AUTO GENERATED FILE\n`
    + `export const scoreToMidi: Record<string, string> = {\n${entries}\n};\n\n`
    + `export default scoreToMidi;\n`;

  fs.writeFileSync(path.join(SCORE_MAPS_DIR, 'scoreToMidi.ts'), content);
}

function writeScoreToMusicxmlMap(musicxmlMap) {
  const entries = Object.entries(musicxmlMap)
    .map(([key, value]) => {
      const cleaned = value
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\')
        .trim();
      return `  "${key}": \`${cleaned}\``;
    })
    .join(',\n');

  const content = `// AUTO GENERATED FILE\n`
    + `export const scoresData: Record<string, string> = {\n${entries}\n};\n\n`
    + `export default scoresData;\n`;

  fs.writeFileSync(path.join(SCORE_MAPS_DIR, 'scoreToMusicxmlMap.ts'), content);
}

function main() {
  console.log('===Asset Mapping Generation Script===');

  if (!fs.existsSync(SCORE_MAPS_DIR)) {
    fs.mkdirSync(SCORE_MAPS_DIR, { recursive: true });
  }

  const { wavMap, csvMap, midiMap, musicxmlMap, errors } = buildMappings();

  if (Object.keys(musicxmlMap).length === 0) {
    console.error('No valid pieces found in public directory.');
    process.exit(1);
  }

  writeScoreToWavMap(wavMap);
  writeScoreToCsvMap(csvMap);
  writeScoreToMidiMap(midiMap);
  writeScoreToMusicxmlMap(musicxmlMap);

  console.log('Generated mapping files in:', SCORE_MAPS_DIR);

  if (errors.length > 0) {
    console.log('Pieces with missing files:');
    errors.forEach(error => {
      console.log(`${error.pieceName}: ${error.missing.join(', ')}`);
    });
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildMappings, writeScoreToWavMap, writeScoreToCsvMap, writeScoreToMidiMap, writeScoreToMusicxmlMap };