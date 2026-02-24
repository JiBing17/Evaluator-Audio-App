import {
  StyleSheet,
  View,
  Animated,
  Platform,
  TouchableOpacity,
} from "react-native";
import RNPickerSelect from "react-native-picker-select";
import React, { useEffect } from "react";
import Icon from "react-native-vector-icons/FontAwesome";
import scoreToMidi from "../score_name_to_data_map/scoreToMidi";
import AudioGenerator from "../audio/AudioGenerator";
import {
  musicXmlUploadWeb,
  musicXmlUploadNative,
} from "../utils/fileSelectorUtils";

export function Score_Select({
  // Data passed from App.tsx
  state,
  dispatch,
  textStyle,
  borderStyle,
  button_format,
  button_text_style,
}: {
  state: any;
  dispatch: Function;
  textStyle: Animated.AnimatedInterpolation<string | number>;
  borderStyle: Animated.AnimatedInterpolation<string | number>;
  button_format: object[];
  button_text_style: Animated.AnimatedInterpolation<string | number>;
}) {
  // Array of score names used to render the available scores for the app
  // Entries are used within a hashmap to access certain data needed for the selected score
  const musicxmlFiles: string[] = [
    "air_on_the_g_string.musicxml",
    "schumann_melodyVLCduet.musicxml",
    "ode_to_joy.musicxml", // NOTE: csv and ref audio for this score to play starts about 4 secs into the performance (piece will not work if live audio starts playing at 0 secs instead of 4ish)

    // no csv data for the bottom 3 scores so they are commented out for now
    // 'sonata.musicxml',
    // 'hark.musicxml',
    // 'green_sleeves.musicxml'
  ];

  // Populate our global stat.scores with the given scores in musicxmlFiles
  useEffect(() => {
    dispatch({ type: "new_scores_from_backend", scores: musicxmlFiles });
  }, [dispatch]);

  return (
    <View>
      <Animated.Text style={[{ color: textStyle }, styles.text]}>
        Select a score:
      </Animated.Text>
      <View
        style={styles.input}
        pointerEvents={state.isplaying ? "none" : "auto"}
      >
        <RNPickerSelect //RNPicker is a new instance depending on the length of score. So, it will rerender if updated
          disabled={state.isplaying} // Can't select score when performance is playing
          key={state.scores.length}
          onValueChange={(value) => {
            // midiModule contains the MIDI file for the selected score (obtained using scoreToMidi hashmap - key=musicxml_name , value=require(path_to_midi_file))
            const midiModule = scoreToMidi[value];

            // Dispatch both into state
            dispatch({
              type: "change_score",
              score: value, // Pass in current score name
              accompanimentSound: midiModule, // Pass in current score's midi file
            });
          }}
          items={state.scores.map((score) => ({
            // Go through each scroe and actually load the score options visually in the selector
            label: score.replace(/\.musicxml$/i, ""), // Remove the .musicxml extension when selecting a score option visually for a better UI experience
            value: score, // Actual value still contains .musicxml extension which we still need for other logic such has the hashmap
          }))}
          placeholder={{
            label: "Select a score",
            value: "",
          }}
          // Drop down arrow for mobile to select score (only visible on mobile version)
          Icon={
            Platform.OS !== "web"
              ? () => <Icon name="chevron-down" size={16} color="#000" />
              : undefined
          }
        />

        {/* Old component used to generate wav files given midi but no longer needed since we have direct access to wav files */}
        {/* This component doesnt render anything visually but just stores the wav audio that is generated from the given midi to the global state */}
        <AudioGenerator
          midiModule={scoreToMidi[state.score]}
          dispatch={dispatch}
        />
      </View>

      {/* Upload WAV file feature */}
      <Animated.Text style={{ color: textStyle, marginTop: 12 }}>
        Or upload a new score:
      </Animated.Text>
      <Animated.View
        style={[
          styles.input,
          {
            borderBottomWidth: 2,
            borderBottomColor: borderStyle,
            paddingBottom: 24,
          },
        ]}
      >
        {/* If on browser render upload field for web*/}
        {Platform.OS === "web" ? (
          <input
            type="file"
            accept=".musicxml"
            onChange={(e) => musicXmlUploadWeb(e, state.scores, dispatch)}
            style={{ color: "#000" }}
            disabled={true}
          />
        ) : (
          // Else render upload field for mobile
          <Animated.View>
            <TouchableOpacity
              onPress={() => musicXmlUploadNative(state.scores, dispatch)}
              disabled={true}
              style={[...button_format, styles.disabledButton]}
            >
              <Animated.Text
                style={{ color: button_text_style, fontWeight: "bold" }}
              >
                Upload File
              </Animated.Text>
            </TouchableOpacity>
          </Animated.View>
        )}
      </Animated.View>
    </View>
  );
}

// Define styles for the components using StyleSheet
const styles = StyleSheet.create({
  // Main text styles (text labels)
  text: {
    fontSize: 24,
    fontWeight: "bold",
    // Text shadow properties
    textShadowColor: "rgba(0, 0, 0, 0.3)", // Shadow color with transparency
    textShadowOffset: { width: 1, height: 1 }, // Slight offset
    textShadowRadius: 4,
  },
  // Styles added to View component that wraps the inputs (used for spacing purposes)
  input: {
    paddingVertical: 12,
  },
  button: {
    padding: 10,
    borderRadius: 8,
    alignItems: "center",
    marginVertical: 5,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.17,
    shadowRadius: 3.05,
    elevation: 4,
    backgroundColor: "#2C3E50",
  },
  button_text: {
    textAlign: "center",
    fontSize: 14,
    color: "#FFF",
    fontWeight: "bold",
  },
  disabledButton: {
    backgroundColor: "#555",
  },
});
