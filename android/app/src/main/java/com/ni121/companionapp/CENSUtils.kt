package com.ni121.companionapp

import be.tarsos.dsp.util.fft.FFT
import be.tarsos.dsp.util.fft.HannWindow
import kotlin.math.sqrt
import kotlin.math.pow
import kotlin.math.cos
import kotlin.math.PI
import kotlin.math.abs

/**
 * Utility class for computing CENS (Chroma Energy Normalized Statistics) features.
 * This is a native Kotlin implementation matching the JavaScript FeaturesCENS.tsx
 */
class CENSUtils(private val sampleRate: Int, private val winLen: Int) {
    
    // TarsosDSP FFT modulus returns winLen/2 bins, not winLen/2+1
    private val numBins = winLen / 2
    private val cFC: Array<FloatArray> // 12 x numBins - conversion matrix from FFT bins to chroma
    
    // Pre-allocated buffers to avoid per-frame allocations
    private val fftLib: FFT
    private val signalBuffer: FloatArray = FloatArray(winLen)
    private val amplitudes: FloatArray = FloatArray(numBins)
    private val chromaVec: DoubleArray = DoubleArray(12)
    private val quantized: DoubleArray = DoubleArray(12)
    private val chromaNorm: DoubleArray = DoubleArray(12)
    
    init {
        // Build the frequency-to-chroma conversion matrix
        cFC = buildChromaConversionMatrix()
        
        // Pre-allocate FFT (create once, reuse every frame)
        fftLib = FFT(winLen, HannWindow())
    }
    
    /**
     * Compute pitch frequencies for MIDI notes.
     * A4 (MIDI 69) = 440 Hz
     */
    private fun pitchFreqs(startPitch: Double, endPitch: Double): DoubleArray {
        val kTRT = 2.0.pow(1.0 / 12.0) // 2^(1/12)
        val numPitches = (endPitch - startPitch).toInt()
        return DoubleArray(numPitches) { i ->
            440.0 * kTRT.pow((startPitch + i) - 69.0)
        }
    }
    
    /**
     * Create frequency-to-pitch conversion matrix (128 x numBins)
     */
    private fun specToPitchMatrix(tuning: Double = 0.0): Array<DoubleArray> {
        val out = Array(128) { DoubleArray(numBins) { 0.0 } }
        
        // Frequencies for each FFT bin (from 0 to Nyquist)
        val binF = DoubleArray(numBins) { i -> (i * sampleRate).toDouble() / winLen }
        
        // Frequency center for each MIDI pitch 0-127 (with tuning offset) and edges
        val pitchCenter = pitchFreqs(0.0 + tuning, 128.0 + tuning)
        val pitchEdges = pitchFreqs(-0.5 + tuning, 128.5 + tuning)
        
        // Hann window of length 128
        val windowLength = 128
        val hann = DoubleArray(windowLength) { i ->
            0.5 - 0.5 * cos((2.0 * PI * i) / (windowLength - 1))
        }
        
        // Fill the conversion matrix
        for (p in 0 until 128) {
            val f1 = pitchEdges[p]
            val f3 = pitchEdges[p + 1]
            for (j in 0 until numBins) {
                val x = binF[j]
                val value: Double = if (x <= f1 || x >= f3) {
                    0.0
                } else {
                    val fraction = (x - f1) / (f3 - f1)
                    val idx = fraction * (windowLength - 1)
                    val i0 = idx.toInt()
                    val frac = idx - i0
                    if (i0 >= windowLength - 1) {
                        hann[windowLength - 1]
                    } else {
                        hann[i0] + frac * (hann[i0 + 1] - hann[i0])
                    }
                }
                out[p][j] = value
            }
        }
        return out
    }
    
    /**
     * Build the full FFT-to-chroma conversion matrix (12 x numBins)
     */
    private fun buildChromaConversionMatrix(): Array<FloatArray> {
        val cFP = specToPitchMatrix(0.0) // 128 x numBins
        
        // c_fc = c_pc * c_fp where c_pc is 12x128 pitch-to-chroma matrix
        val result = Array(12) { FloatArray(numBins) { 0f } }
        for (chroma in 0 until 12) {
            for (j in 0 until numBins) {
                var sum = 0.0
                // Sum over all pitches that map to this chroma class
                for (pitch in chroma until 128 step 12) {
                    sum += cFP[pitch][j]
                }
                result[chroma][j] = sum.toFloat()
            }
        }
        return result
    }
    
    /**
     * Compute CENS chroma features from an audio frame.
     * @param audioFrame Audio samples of length winLen
     * @return 12-dimensional CENS chroma vector (L2 normalized)
     */
    fun computeCENS(audioFrame: FloatArray): DoubleArray {
        require(audioFrame.size == winLen) {
            "Audio frame length ${audioFrame.size} doesn't match expected $winLen"
        }
        
        // 1) Copy audio to signal buffer and compute FFT with Hann window
        audioFrame.copyInto(signalBuffer)
        fftLib.forwardTransform(signalBuffer)
        
        // 2) Get magnitude spectrum
        fftLib.modulus(signalBuffer, amplitudes)
        
        // 3) Convert to chroma by projecting power spectrum onto pitch classes
        for (i in 0 until 12) {
            var sum = 0.0
            for (j in 0 until numBins) {
                // Use power = amplitude^2
                sum += cFC[i][j] * amplitudes[j] * amplitudes[j]
            }
            chromaVec[i] = sum
        }
        
        // CENS post-processing:
        // Step 1) Normalize by L1 norm
        var L1 = 0.0
        for (i in 0 until 12) {
            L1 += abs(chromaVec[i])
        }
        if (L1 == 0.0) {
            for (i in 0 until 12) chromaVec[i] = 1.0
            L1 = 12.0
        }
        for (i in 0 until 12) {
            chromaVec[i] /= L1
        }
        
        // Step 2) Quantize according to logarithmic scheme (values 0-4)
        val values = intArrayOf(1, 2, 3, 4)
        val thresholds = doubleArrayOf(0.05, 0.1, 0.2, 0.4, 1.0)
        for (i in 0 until 12) {
            quantized[i] = 0.0
        }
        for (idx in values.indices) {
            val v = values[idx].toDouble()
            val lower = thresholds[idx]
            val upper = thresholds[idx + 1]
            for (i in 0 until 12) {
                if (chromaVec[i] > lower && chromaVec[i] <= upper) {
                    quantized[i] = v
                }
            }
        }
        
        // Step 3) (Optional smoothing - omitted)
        
        // Step 4) Normalize by L2 norm
        var L2 = 0.0
        for (i in 0 until 12) {
            L2 += quantized[i] * quantized[i]
        }
        L2 = sqrt(L2)
        if (L2 == 0.0) {
            for (i in 0 until 12) quantized[i] = 1.0
            L2 = sqrt(12.0)
        }
        
        for (i in 0 until 12) {
            chromaNorm[i] = quantized[i] / L2
        }
        
        // Return a copy to avoid returning internal buffer that may be modified
        return chromaNorm.copyOf()
    }
}
