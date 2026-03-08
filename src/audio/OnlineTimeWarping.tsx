import { Features } from "./Features";
import { NativeModules } from "react-native";

const { OnlineTimeWarpingModule } = NativeModules;

export default class OnlineTimeWarping {
  ref: Features<unknown>;
  refLen: number;
  live: Features<unknown>;
  accumulatedCost: number[][]; // Kept for compatibility with ScoreFollower.getBackwardsPath
  winSize: number;
  maxRunCount: number;
  diagWeight: number;
  refIdx: number;
  liveIdx: number;
  lastRefIdx: number;
  path_z: number[];
  netCostComputationTime: number;
  private initialized: boolean = false;

  constructor(
    ref: Features<unknown>,
    bigC: number,
    maxRunCount: number,
    diagWeight: number,
  ) {
    this.ref = ref;
    this.refLen = ref.count;
    this.live = ref.cloneEmpty();
    this.accumulatedCost = []; // Not used in native implementation

    this.winSize = bigC;
    this.maxRunCount = maxRunCount;
    this.diagWeight = diagWeight;

    this.refIdx = 0;
    this.liveIdx = -1;
    this.lastRefIdx = 0;
    this.path_z = [];
    this.netCostComputationTime = 0;

    // Initialize native module
    this.initializeNative();
  }

  private async initializeNative(): Promise<void> {
    if (this.initialized) return;

    try {
      const refFeatures = this.ref.featuregram as number[][];
      await OnlineTimeWarpingModule.initialize(
        refFeatures,
        this.winSize,
        this.maxRunCount,
        this.diagWeight,
      );
      this.initialized = true;
      console.log("OnlineTimeWarping: Native module initialized");
    } catch (e) {
      console.error("OnlineTimeWarping: Failed to initialize native module", e);
      throw e;
    }
  }

  /**
   * Insert a new live input frame (audio frame) and estimate the current position in the reference time series.
   * @param audioFrame - Live audio frame as number[]
   * @returns Estimated position in the reference sequence
   */
  async insert(audioFrame: number[]): Promise<number> {
    // Ensure native module is initialized
    if (!this.initialized) {
      await this.initializeNative();
    }

    this.liveIdx += 1;

    const startTime = Date.now();

    // Compute chroma features from audio frame
    const chromaVec = await this.live.insert(audioFrame);

    // Pass chroma to native module for DTW computation
    const currentRefPosition = await OnlineTimeWarpingModule.insert(chromaVec);

    this.refIdx = currentRefPosition;
    this.lastRefIdx = currentRefPosition;
    this.path_z.push(currentRefPosition);

    const endTime = Date.now();
    this.netCostComputationTime += endTime - startTime;
    console.log(
      `Net cost computation time is ${this.netCostComputationTime}ms`,
    );

    return currentRefPosition;
  }

  /**
   * Fetch the accumulated cost matrix from the native module.
   * Used by ScoreFollower.getBackwardsPath for path analysis.
   */
  async fetchAccumulatedCost(): Promise<number[][]> {
    if (!this.initialized) {
      await this.initializeNative();
    }
    this.accumulatedCost = await OnlineTimeWarpingModule.getAccumulatedCost();
    return this.accumulatedCost;
  }
}
