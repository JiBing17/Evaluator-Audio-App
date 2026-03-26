export type NoteColor = {
  index: number;
  color: string;
};

/**
 * Centralized configuration for OpenSheetMusicDisplay visual settings.
 * Adjusting these values will update the display across both Web and Mobile.
 */
export const OSMD_CONFIG = {
  // Cursor appearance
  cursorColor: "#49FF2D",
  cursorAlpha: 0.3,

  // Note annotation colors
  noteColorNeutral: "#000000",
  noteColorSharp: "#FFAE3C",
  noteColorFlat: "#4A86FF",

  // Zoom levels for different platforms and screen sizes
  zoomWeb: {
    large: 0.65,
    small: 0.45,
  },
  zoomNative: {
    large: 0.65,
    small: 1.1, // Native often needs higher zoom on small screens
  },

  // Other visual defaults
  drawTitle: false,
  drawPartNames: false,
  followCursor: true,
};
