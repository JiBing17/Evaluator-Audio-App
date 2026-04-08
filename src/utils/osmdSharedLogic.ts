/**
 * Shared logic for OpenSheetMusicDisplay that can be used in both standard web
 * and injected into a React Native WebView.
 */

import { OSMD_CONFIG } from "./osmdConfig";

/**
 * A "no-op" template tag to trigger syntax highlighting in IDEs 
 * (like VS Code with the "es6-string-javascript" extension).
 */
const javascript = (strings: TemplateStringsArray) => strings[0];

/**
 * Default configuration for OSMD and Cursor.
 */
export const getOsmdUnitOptions = (
  cursorColor: string = OSMD_CONFIG.cursorColor,
  cursorAlpha: number = OSMD_CONFIG.cursorAlpha,
) => {
  return {
    osmdOptions: {
      autoResize: true,
      backend: "svg",
      drawTitle: OSMD_CONFIG.drawTitle,
      drawPartNames: OSMD_CONFIG.drawPartNames,
      followCursor: OSMD_CONFIG.followCursor,
      cursorsOptions: [
        { type: 0, color: cursorColor, follow: true, alpha: cursorAlpha },
      ],
    },
    cursorOptions: {
      follow: true,
      color: cursorColor,
      alpha: cursorAlpha,
      type: 0,
    },
  };
};

/**
 * AUTHORITATIVE SOURCE CODE
 * We store these as strings because React Native (Hermes) may strip
 * function source code, making func.toString() return "bytecode".
 */

export const SHARED_OSMD_LOGIC = {
  applyNoteColors: javascript`
  function(osm, noteColors) {
    if (!osm || !osm.GraphicSheet) return;
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
    const colorMap = new Map();
    (noteColors || []).filter(n => n != null).forEach(n => colorMap.set(n.index, n.color));
    allGraphicalNotes.forEach((gNote, idx) => {
      const color = colorMap.get(idx);
      if (!color && color !== "") return;
      try {
        if (gNote.sourceNote) {
          if (typeof gNote.sourceNote.NoteheadColor !== "undefined") {
            gNote.sourceNote.NoteheadColor = color;
          } else if (gNote.sourceNote.Notehead) {
            gNote.sourceNote.Notehead.color = color;
          } else {
            gNote.sourceNote.color = color;
          }
        }
        const vf = gNote.vfnote;
        if (vf) {
          if (typeof vf.setStyle === "function") {
            vf.setStyle({ fillStyle: color, strokeStyle: color });
          }
          if (vf.note_heads && Array.isArray(vf.note_heads)) {
            vf.note_heads.forEach(head => {
              if (head.setStyle) head.setStyle({ fillStyle: color, strokeStyle: color });
            });
          }
        }
      } catch (err) { console.warn("sharedApplyNoteColors: failed for index", idx, err); }
    });
    try { osm.render(); } catch (e) { console.error("osmd.render() failed", e); }
  }`,

  stepCursor: javascript`
  function(osm, targetBeats) {
    if (!osm || !osm.cursor || !osm.IsReadyToRender()) return;
    const iterator = osm.cursor.Iterator;
    let baseDenom = 4;
    const measureList = osm.GraphicSheet.MeasureList;
    if (measureList && measureList.length > 0 && measureList[0].length > 0) {
      const firstMeasure = measureList[0][0].parentSourceMeasure;
      if (firstMeasure && firstMeasure.ActiveTimeSignature) {
        baseDenom = firstMeasure.ActiveTimeSignature.Denominator;
      }
    }
    const getCurrentBeats = () => iterator.currentTimeStamp.RealValue * baseDenom;
    let currentBeats = getCurrentBeats();
    const EPSILON = 0.001;
    if (targetBeats < currentBeats - EPSILON) {
      osm.cursor.reset();
      currentBeats = getCurrentBeats();
    }
    const MAX_ITERATIONS = 1000;
    let iterations = 0;
    while (iterations < MAX_ITERATIONS) {
      if (osm.cursor.EndOfSheet) break;
      const preMoveTimestamp = iterator.currentTimeStamp.RealValue;
      osm.cursor.next();
      const postMoveTimestamp = iterator.currentTimeStamp.RealValue;
      const postMoveBeats = postMoveTimestamp * baseDenom;
      if (postMoveTimestamp === preMoveTimestamp) break;
      if (postMoveBeats > targetBeats + EPSILON) {
        osm.cursor.previous();
        break;
      }
      currentBeats = postMoveBeats;
      iterations++;
    }
    osm.render();
  }`,

  extractTempo: javascript`
  function(xmlString) {
    try {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlString, "application/xml");
      const sound = xmlDoc.querySelector("sound[tempo]");
      if (sound && sound.getAttribute("tempo")) {
        return parseFloat(sound.getAttribute("tempo"));
      }
      const perMin = xmlDoc.querySelector("metronome > per-minute");
      if (perMin && perMin.textContent) {
        return parseFloat(perMin.textContent);
      }
      return null;
    } catch (e) {
      console.warn("sharedExtractTempo: failed", e);
      return null;
    }
  }`
};

/**
 * Functional versions for the Web environment.
 */
export const sharedApplyNoteColors = eval(`(${SHARED_OSMD_LOGIC.applyNoteColors})`);
export const sharedStepCursor = eval(`(${SHARED_OSMD_LOGIC.stepCursor})`);
export const sharedExtractTempo = eval(`(${SHARED_OSMD_LOGIC.extractTempo})`);
