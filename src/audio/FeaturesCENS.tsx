/*
Copyright (c) 2024 Matthew Caren

Permission is hereby granted, free of charge, to any person obtaining a copy of 
this software and associated documentation files (the "Software"), to deal in 
the Software without restriction, including without limitation the rights to 
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all 
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR 
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR 
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER 
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN 
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

import { Features, FeaturesConstructor } from "./Features";
const { fft } = require('fft-js');

/**
 * Returns the center frequency for each MIDI pitch in the range [start_pitch, end_pitch).
 * @param start_pitch - starting MIDI pitch (inclusive)
 * @param end_pitch - one more than the last MIDI pitch value (exclusive)
 * @returns Array of length (end_pitch - start_pitch) with frequencies in Hz.
 */
function pitch_freqs(start_pitch: number = 0, end_pitch: number = 128): number[] {
    const kTRT = Math.pow(2, 1/12.0);  // 2^(1/12)
    const freqs: number[] = [];
    for (let p = start_pitch; p < end_pitch; p += 1) {
        // Calculate frequency for MIDI pitch p (A4=69 -> 440 Hz)
        const freq = 440 * Math.pow(kTRT, p - 69);
        freqs.push(freq);
    }
    return freqs;
}

/**
 * Create a conversion matrix from an FFT spectrum vector to a MIDI pitch vector (log-frequency spectrogram).
 * @param fs - sample rate of the audio
 * @param fft_len - the length of the FFT
 * @param tuning - optional pitch adjustment in semitones (MIDI) for alternate tunings (default 0)
 * @returns A matrix of shape (128, num_bins) where num_bins = fft_len//2 + 1 (number of frequency bins in rfft output).
 * Each row corresponds to a MIDI pitch (0-127) and each column to an FFT bin, representing the contribution of that bin's frequency to the given pitch.
 */
function spec_to_pitch_mtx(fs: number, fft_len: number, tuning: number = 0.0): number[][] {
    const num_bins = Math.floor(fft_len / 2) + 1;
    // Initialize output matrix 128 x num_bins with zeros
    const out: number[][] = Array.from({ length: 128 }, () => new Array(num_bins).fill(0));

    // Frequencies for each FFT bin (from 0 to Nyquist)
    const bin_f: number[] = [];
    for (let i = 0; i < num_bins; i++) {
        bin_f.push(i * fs / fft_len);
    }

    // Frequency center for each MIDI pitch 0-127 (with tuning offset) and edges for each pitch band
    const pitch_center = pitch_freqs(0 + tuning, 128 + tuning);
    const pitch_edges = pitch_freqs(-0.5 + tuning, 128.5 + tuning);

    // Precompute a Hann window of length 128 (for distributing bin contributions across pitch frequencies)
    const windowLength = 128;
    const hann: number[] = new Array(windowLength);
    for (let i = 0; i < windowLength; i++) {
        // Hann (Hanning) window formula
        hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (windowLength - 1));
    }

    // Fill the conversion matrix
    for (let p = 0; p < 128; p++) {
        const f1 = pitch_edges[p];
        const f3 = pitch_edges[p + 1];
        for (let j = 0; j < num_bins; j++) {
            const x = bin_f[j];
            let value: number;
            if (x <= f1 || x >= f3) {
                // Outside the pitch band - assign 0 (Hann window is zero at edges)
                value = 0;
            } else {
                // Linearly interpolate the Hann window value at frequency x between f1 and f3
                const fraction = (x - f1) / (f3 - f1);
                const idx = fraction * (windowLength - 1);
                const i0 = Math.floor(idx);
                const frac = idx - i0;
                // Ensure index is within [0, windowLength-2] for interpolation
                if (i0 >= windowLength - 1) {
                    // If x is extremely close to f3 (fraction ~1), just use last value
                    value = hann[windowLength - 1];
                } else {
                    value = hann[i0] + frac * (hann[i0 + 1] - hann[i0]);
                }
            }
            out[p][j] = value;
        }
    }
    return out;
}

function dot(vec1: number[], vec2: number[]): number {
    let sum = 0;
    for (let i = 0; i < vec1.length; i++) {
        sum += vec1[i] * vec2[i];
    }
    return sum;
}

/**
 * Streaming implementation to convert audio frames (of length n_fft) into 12-dimensional CENS chroma vectors.
 */
export class CENSFeatures extends Features<number[]> {
    hanningWindow: number[];
    cFC: number[][];  // conversion matrix from FFT bins to chroma (12) bins
    
    constructor(sr: number, winLen: number, audioSamples?: number[], hopLen?: number) {
        super(sr, winLen, audioSamples, hopLen);
    }

    private ensureHanningWindow() {
        if (this.hanningWindow) return;

        // 1) Create Hann (Hanning) window for FFT
        const n_fft = this.winLen;
        this.hanningWindow = new Array(n_fft);
        for (let i = 0; i < n_fft; i++) {
            this.hanningWindow[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n_fft - 1));
        }
        // 2) Compute frequency-to-pitch conversion matrix (c_fp) for this sr and n_fft
        const tuning = 0.0;
        const c_fp = spec_to_pitch_mtx(this.sr, n_fft, tuning);  // shape 128 x (n_fft/2+1)
        // 3) Compute pitch-to-chroma (class) conversion matrix (c_pc)
        //    c_pc is a 12x128 matrix mapping 128 MIDI pitches to 12 pitch classes.
        const c_pc: number[][] = Array.from({ length: 12 }, () => new Array(128).fill(0));
        for (let p = 0; p < 128; p++) {
            const pitch_class = p % 12;
            c_pc[pitch_class][p] = 1;
        }
        // 4) Compute full conversion from FFT bins to chroma: c_fc = c_pc * c_fp (matrix multiply)
        const num_bins = Math.floor(n_fft / 2) + 1;
        this.cFC = Array.from({ length: 12 }, () => new Array(num_bins).fill(0));
        for (let chroma = 0; chroma < 12; chroma++) {
            for (let j = 0; j < num_bins; j++) {
                let sum = 0;
                // sum over all pitches that map to this chroma class
                for (let pitch = chroma; pitch < 128; pitch += 12) {
                    sum += c_fp[pitch][j];
                }
                this.cFC[chroma][j] = sum;
            }
        }
    }

    compareFeatures(vec1: number[], vec2: number[]): number {
        return dot(vec1, vec2);
    }

    /**
     * Insert a new audio frame and compute its CENS chroma vector.
     * @param y - audio frame of length n_fft (samples)
     * @returns An array of length 12 representing the CENS chroma features for this frame.
     */
    makeFeature(y: number[]): number[] {
        this.ensureHanningWindow();
        
        const n_fft = this.winLen;
        if (y.length !== n_fft) {
            throw new Error(`Input frame length ${y.length} does not match expected length ${n_fft}.`);
        }
        // 1) Apply Hann window to the audio frame
        const sig = new Array(n_fft);
        for (let i = 0; i < n_fft; i++) {
            sig[i] = (y as any)[i] * this.hanningWindow[i];
        }
        // 2) Compute magnitude spectrum using FFT (real FFT since input is real)
        // Use fft-js to compute FFT. It returns an array of [real, imag] pairs.
        const phasors = fft(sig);
        const num_bins = Math.floor(n_fft / 2) + 1;
        // Take the magnitude (absolute value) of FFT output for bins 0..num_bins-1
        const X: number[] = new Array(num_bins);
        for (let k = 0; k < num_bins; k++) {
            const re = phasors[k][0];
            const im = phasors[k][1];
            X[k] = Math.sqrt(re * re + im * im);
        }
        // Convert to chroma by projecting the power spectrum onto pitch classes:
        // We use X**2 (power) for projection (as in Python code X**2).
        const chromaVec: number[] = new Array(12).fill(0);
        for (let i = 0; i < 12; i++) {
            let sum = 0;
            for (let j = 0; j < num_bins; j++) {
                // use power = X[j]^2
                sum += this.cFC[i][j] * (X[j] * X[j]);
            }
            chromaVec[i] = sum;
        }

        // CENS post-processing steps:
        // Step 1) Normalize by L1 norm (sum of absolute values)
        let L1 = 0;
        for (let i = 0; i < 12; i++) {
            L1 += Math.abs(chromaVec[i]);
        }
        if (L1 === 0) {
            // if all zeros, set each to 1 (to avoid division by zero)
            chromaVec.fill(1);
            L1 = 12;
        }
        for (let i = 0; i < 12; i++) {
            chromaVec[i] /= L1;
        }

        // Step 2) Quantize according to a logarithmic scheme (resulting values 0–4)
        const quantized: number[] = new Array(12).fill(0);
        const values = [1, 2, 3, 4];
        const thresholds = [0.05, 0.1, 0.2, 0.4, 1.0];
        for (let idx = 0; idx < values.length; idx++) {
            const v = values[idx];
            const lower = thresholds[idx];
            const upper = thresholds[idx + 1];
            for (let i = 0; i < 12; i++) {
                if (chromaVec[i] > lower && chromaVec[i] <= upper) {
                    quantized[i] = v;
                }
            }
        }
        // Any chroma value <= 0.05 remains 0 in quantized (above loop doesn't set it)

        // Step 3) (Optional smoothing step would be here - omitted)

        // Step 4) Normalize by L2 norm
        let L2 = 0;
        for (let i = 0; i < 12; i++) {
            L2 += quantized[i] * quantized[i];
        }
        L2 = Math.sqrt(L2);
        if (L2 === 0) {
            // if all zero (shouldn't happen after step 1 unless all were exactly 0),
            // set each to 1 (so each value is 1) and adjust L2 to sqrt(12)
            quantized.fill(1);
            L2 = Math.sqrt(12);
        }
        const chromaNorm: number[] = new Array(12);
        for (let i = 0; i < 12; i++) {
            chromaNorm[i] = quantized[i] / L2;
        }
        return chromaNorm;
    }

    cloneEmpty(): this {
        return new CENSFeatures(this.sr,  this.winLen) as this;
    }
}
