import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";

/**
 * Represents a selected WAV file with URI and name.
 */
export interface LiveFile {
  uri: string;
  name: string;
}

/**
 * Parses a web-based file input change event to extract a WAV file reference.
 *
 * @param e - Change event from an <input type="file" accept=".wav" />
 * @returns LiveFile object or null if no valid WAV file was selected
 */
export const parseWebWavFile = (
  e: React.ChangeEvent<HTMLInputElement>,
): LiveFile | null => {
  const file = e.target.files?.[0] ?? null; // Get the first file selected, or null if none
  if (file && file.name.toLowerCase().endsWith(".wav")) {
    // Check if it's a .wav file (case-insensitive)
    return { uri: URL.createObjectURL(file), name: file.name }; // Create a blob URL so the file can be accessed in the browser
  }
  return null; // Return null if no valid file was selected
};

/**
 * Opens the mobile document picker to select a WAV file (Expo).
 *
 * @returns Promise resolving to LiveFile or null if selection was canceled or invalid
 */
export const pickMobileWavFile = async (): Promise<LiveFile | null> => {
  try {
    const res = await DocumentPicker.getDocumentAsync({
      // Open the document picker with .wav file restriction
      type: ["audio/wav", "audio/x-wav", "audio/wave"],
      copyToCacheDirectory: true, // Cache locally for faster access
    });
    if (!res.canceled && res.assets && res.assets.length > 0) {
      // Check if the user selected a file and it contains asset info
      const asset = res.assets[0];
      return { uri: asset.uri, name: asset.name }; // Return a simplified object with just the URI and file name
    }
  } catch (err) {
    console.error("DocumentPicker Error:", err); // Log any picker-related errors
  }
  return null; // Return null if canceled or on error
};
