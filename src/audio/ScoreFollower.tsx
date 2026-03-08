import { Features, FeaturesConstructor } from "./Features";
import OnlineTimeWarping from "./OnlineTimeWarping";
import { prepareAudio } from "../utils/audioUtils";

/**
 * Performs online dynamic time warping (DTW) between reference audio and live microphone audio.
 */
export class ScoreFollower {
  FeaturesClass: FeaturesConstructor<any>;
  sr: number;
  winLen: number;
  path: [number, number][];
  ref!: Features<unknown>;
  otw!: OnlineTimeWarping;

  /**
   * Private constructor. Use the static async create() method to instantiate.
   */
  private constructor(
    FeaturesClass: FeaturesConstructor<any>,
    sr: number,
    winLen: number,
  ) {
    this.FeaturesClass = FeaturesClass;
    this.sr = sr;
    this.winLen = winLen;
    this.path = [];
  }

  /**
   * Asynchronously creates a ScoreFollower by loading the reference audio and initializing OTW.
   * @param refUri Path to reference audio file
   * @param bigC Width of online DTW search (default 50)
   * @param maxRunCount Slope constraint for online DTW (default 3)
   * @param diagWeight Diagonal weight for OTW (default 0.75)
   * @param sr Sample rate of the audio buffer (default 44100)
   * @param winLen Number of frames per feature (default 4096)
   * @param hopLen Number of samples between frames (default winLen)
   */
  static async create(
    refUri: string,
    FeaturesClass: FeaturesConstructor<any>,
    bigC = 50,
    maxRunCount = 3,
    diagWeight = 0.75,
    sr = 44100,
    winLen = 4096,
    hopLen = winLen,
  ) {
    const instance = new ScoreFollower(FeaturesClass, sr, winLen);
    instance.ref = await instance.loadRefFromAudio(
      refUri,
      FeaturesClass,
      sr,
      winLen,
      hopLen,
    );
    console.log(
      "-- Reference loaded — initializing OTW with bigC=",
      bigC,
      "maxRunCount=",
      maxRunCount,
    );

    instance.otw = new OnlineTimeWarping(
      instance.ref,
      bigC,
      maxRunCount,
      diagWeight,
    );
    console.log("ScoreFollower.create(): done");

    return instance;
  }

  /**
   * Calculate next step in the alignment path between microphone and reference audio.
   * @param audioFrame Live audio frame
   * @returns Estimated position in the reference audio in seconds
   */
  async step(audioFrame: number[]): Promise<number> {
    if (audioFrame.length < this.winLen) {
      const padding = Array(this.winLen - audioFrame.length).fill(0);
      audioFrame = audioFrame.concat(padding);
    }

    const refIndex = await this.otw.insert(audioFrame);
    this.path.push([refIndex, this.otw.liveIdx]);
    return ((refIndex + 1) * this.winLen) / this.sr;
  }

  private async loadRefFromAudio(
    refUri: string,
    FeaturesClass: FeaturesConstructor<any>,
    sr: number,
    winLen: number,
    hopLen: number = winLen,
  ) {
    console.log("ScoreFollower.loadRefFromAudio(): fetching", refUri);

    const audioData = await prepareAudio(refUri, sr);

    console.log("-- Building featuregram…");

    const features = new FeaturesClass(sr, winLen);
    await features.populate(audioData, hopLen);
    console.log("-- Featuregram length=", features.featuregram.length);

    return features;
  }

  /**
   * Retrieves a backward path of given length through the cost matrix.
   * @param b Number of steps to go back
   * @returns Backwards path as list of (refIndex, liveIndex)
   */
  async getBackwardsPath(b: number): Promise<[number, number][]> {
    // Fetch the accumulated cost matrix from native module
    const costMatrix = await this.otw.fetchAccumulatedCost();
    let j = this.otw.refIdx;
    let t = this.otw.liveIdx;
    const backwardsPath: [number, number][] = [];

    while (j > this.otw.refIdx - b && !backwardsPath.includes([0, 0])) {
      const down = costMatrix[j - 1][t];
      const left = costMatrix[j][t - 1];
      const diag = costMatrix[j - 1][t - 1];

      const minimum = Math.min(down, left, diag);

      if (minimum === down) {
        backwardsPath.push([j - 1, t]);
        j -= 1;
      } else if (minimum === left) {
        backwardsPath.push([j, t - 1]);
        t -= 1;
      } else {
        backwardsPath.push([j - 1, t - 1]);
        j -= 1;
        t -= 1;
      }
    }

    return backwardsPath;
  }

  /**
   * Computes the difference between the forward path and a backward path.
   * @param backPath Backwards path
   * @returns Path elements in forward path but not in backPath
   */
  getPathDifference(backPath: [number, number][]): [number, number][] {
    return this.path.filter(
      ([r, l]) => !backPath.some(([br, bl]) => br === r && bl === l),
    );
  }
}
