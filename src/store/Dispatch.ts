import { NoteColor } from "../utils/osmdConfig";

const reducer_function = (state: any, action: any) => {
  // console.log("Dispatch received.");
  // Conventions vary, but this one is rather common - the action argument
  // should be an object with the type property; this determines what type
  // of action to carry out on the state.  The action can have other properties;
  // for example, some value to which some property of the state is to be changed

  // Note that these functions only affect the state - things like the visible cursor
  // position and playback rate of the audio must be made to depend on the state
  // (likely with useEffect) in order to work.

  switch (action.type) {
    // Example of dispatch call with no special parameters:
    // this object-join notation causes state to only change in one property, playing,
    // which becomes the opposite of what it was before.

    case "start/stop": // Toggle boolean (true or false) to determine current playing state
      return { ...state, ...{ playing: !state.playing } };

    case "update_piece_info": // Keep current global state values, but update tempo and beatsPerMeasure to what was passed in
      return {
        ...state,
        ...{
          tempo: action.tempo as number,
          beatsPerMeasure: action.beatsPerMeasure,
        },
      };

    case "change_score": // Keep current global state values, but update score name, accompanimentSound (not applicable in Evaluator project), and set playing to false
      return {
        ...state,
        ...{
          score: action.score,
          accompanimentSound: action.accompanimentSound,
          playing: false,
        },
      };

    case "new_scores_from_backend": // Gets list of scores - without overwriting uploaded score
      var known_files = state.scores;
      var new_files = action.scores.filter(
        (filename: string) => !known_files.includes(filename),
      );
      console.log("New files are: ", new_files);
      return {
        ...state,
        ...{
          scores: [...state.scores, ...new_files],
        },
      };

    case "new_score_from_upload": // Keep the existing state and add the new score content to the scoreContents object using the filename as the key
      return {
        ...state,
        scores: [...state.scores, action.score.filename], // Add the new score filename to the scores array
        score: action.score.filename, // Set the current score to the newly uploaded filename
        scoreContents: {
          ...state.scoreContents, // Keep existing score content
          [action.score.filename]: action.score.content, // Add the new score content to the scoreContents object using the filename as the key
        },
      };

    case "change_reference_audio": // Keep the existing state and update the URI for reference audio
      // console.log(
      //   "[reducer] referenceAudioUri stored in state:",
      //   action.referenceAudioUri,
      // );
      return {
        ...state,
        referenceAudioUri: action.referenceAudioUri as string,
      };

    case "SET_ESTIMATED_BEAT": // Keep the existing state and update estimatedBeat variable
      // console.log("[reducer] Estimated beat:", action.payload);
      return {
        ...state,
        estimatedBeat: action.payload as number,
      };

    case "SET_ESTIMATED_PITCH": // Keep the existing state and  update estimatedBeat variable
      // console.log("[reducer] Estimated pitch:", action.payload);
      return {
        ...state,
        estimatedPitch: action.payload as number,
      };

    case "SET_NOTE_COLORS":
      // console.log("[reducer] # of note colors:", action.payload.length);
      return {
        ...state,
        noteColors: action.payload as NoteColor[],
      };

    case "ADD_NOTE_COLOR":
      const newNoteColors = [...state.noteColors];
      newNoteColors[action.payload.index] = action.payload.color;
      return {
        ...state,
        noteColors: newNoteColors,
      };

    case "change_bottom_audio": // Keep the existing state and update the URI for playback audio (second instrument - only used in Companion Project) audio
      return {
        ...state,
        bottomAudioUri: action.bottomAudioUri as string,
      };

    case "toggle_loading_performance": // Keep the existing state and toggle the loadingPerformance boolean (true or false values)
      return {
        ...state,
        loadingPerformance: !state.loadingPerformance,
      };

    default: // If no valid type, return state, otherwise the function returns null and the state is gone.
      return state;
  }
};

export default reducer_function;
