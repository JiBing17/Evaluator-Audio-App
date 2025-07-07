/*
Copyright (c) 2024 Matthew Caren

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import { Features } from "./Features";

function argmin(arr: number[]): number {
    return arr.reduce((minIdx, val, idx, a) => (val < a[minIdx] ? idx : minIdx), 0);
}

export default class OnlineTimeWarping {
    ref: Features<unknown>;  // Reference sequence (assumed chroma)
    refLen: number;  // Length of the reference sequence
    live: Features<unknown>;  // Live input sequence initialized empty
    accumulatedCost: number[][];  // Accumulated cost matrix initialized with Infinity
    winSize: number;
    maxRunCount: number;
    diagWeight: number;
    refIdx: number;
    liveIdx: number;
    prevStep: string;  // 'ref' | 'live' | 'both'
    runCount: number;
    lastRefIdx: number;
    path_z: number[];  // Chosen path for debugging or tracking

    constructor(ref: Features<unknown>, bigC: number, maxRunCount: number, diagWeight: number) {
        this.ref = ref;
        this.refLen = ref.count;
        this.live = ref.cloneEmpty();
        this.accumulatedCost = Array.from({ length: this.refLen }, () => new Array(this.refLen * 4).fill(Infinity));

        this.winSize = bigC;
        this.maxRunCount = maxRunCount;
        this.diagWeight = diagWeight;

        this.refIdx = 0;
        this.liveIdx = -1;
        this.prevStep = "---";
        this.runCount = 1;

        this.lastRefIdx = 0;
        this.path_z = [];
    }

    /**
     * Insert a new live input frame (chroma vector) and estimate the current position in the reference time series.
     * @param audioFrame - Live chroma vector as number[]
     * @returns Estimated position in the reference sequence
     */
    insert(audioFrame: number[]): number {
        this.liveIdx += 1;
        this.live.insert(audioFrame);

        for (let k = Math.max(0, this.refIdx - this.winSize + 1); k <= this.refIdx; k++) {
            this._update_accumulated_cost(k, this.liveIdx);
        }

        const path: [number, number][] = [];

        while (true) {
            const [step, path_point] = this._get_best_step();
            path.push(path_point);

            if (step === "live") break;

            this.refIdx = Math.min(this.refIdx + 1, this.refLen - 1);

            for (let k = Math.max(this.liveIdx - this.winSize + 1, 0); k <= this.liveIdx; k++) {
                this._update_accumulated_cost(this.refIdx, k);
            }

            if (step === "both") break;
        }

        let current_ref_position = path[path.length - 1][0];
        this.path_z.push(current_ref_position);

        if (current_ref_position < this.lastRefIdx) {
            current_ref_position = this.lastRefIdx;
        }

        this.lastRefIdx = current_ref_position;
        return current_ref_position;
    }

    /**
     * Determines the best step (ref, live, or both) based on the accumulated cost matrix.
     * @returns A tuple containing the best step and the indices [ref_idx, live_idx].
     */
    private _get_best_step(): [string, [number, number]] {
        const row_costs = this.accumulatedCost[this.refIdx].slice(0, this.liveIdx + 1);
        const col_costs = this.accumulatedCost.map(row => row[this.liveIdx]).slice(0, this.refIdx + 1);

        let best_t = argmin(row_costs);
        let best_j = argmin(col_costs);
        let step: string;

        if (this.accumulatedCost[best_j][this.liveIdx] < this.accumulatedCost[this.refIdx][best_t]) {
            best_t = this.liveIdx;
            step = "live";
        } else if (this.accumulatedCost[best_j][this.liveIdx] > this.accumulatedCost[this.refIdx][best_t]) {
            best_j = this.refIdx;
            step = "ref";
        } else {
            best_t = this.liveIdx;
            best_j = this.refIdx;
            step = "both";
        }

        if (best_t === this.liveIdx && best_j === this.refIdx) step = "both";
        if (this.liveIdx < this.winSize) step = "both";
        if (this.runCount >= this.maxRunCount) step = this.prevStep === "ref" ? "live" : "ref";

        if (step === "both" || this.prevStep !== step) {
            this.runCount = 1;
        } else {
            this.runCount += 1;
        }

        this.prevStep = step;
        if (this.refIdx === this.refLen - 1) step = "live";

        return [step, [best_j, best_t]];
    }

    /**
     * Updates the accumulated cost matrix at the given indices using the cost function.
     * The cost is computed as `1 - dot(ref[:, ref_index], live[:, live_index])`.
     * Considers diagonal, vertical, and horizontal transitions.
     * @param refIdx - Index in the reference sequence
     * @param liveIdx - Index in the live sequence
     */
    private _update_accumulated_cost(refIdx: number, liveIdx: number): void {
        const cost = 1 - this.ref.compare(this.live, refIdx, liveIdx)
        
        if (refIdx === 0 && liveIdx === 0) {
            this.accumulatedCost[refIdx][liveIdx] = cost;
            return;
        }

        const steps: number[] = [];

        if (refIdx > 0 && liveIdx > 0) {
            steps.push(this.accumulatedCost[refIdx - 1][liveIdx - 1] + this.diagWeight * cost);
        }
        if (refIdx > 0) {
            steps.push(this.accumulatedCost[refIdx - 1][liveIdx] + cost);
        }
        if (liveIdx > 0) {
            steps.push(this.accumulatedCost[refIdx][liveIdx - 1] + cost);
        }

        this.accumulatedCost[refIdx][liveIdx] = Math.min(...steps);
    }
}