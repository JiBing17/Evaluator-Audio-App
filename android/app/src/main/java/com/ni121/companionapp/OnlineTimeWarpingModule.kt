package com.ni121.companionapp

import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray

class OnlineTimeWarpingModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    
    companion object {
        private const val TAG = "OnlineTimeWarpingModule"
    }

    // Reference featuregram (chroma vectors)
    private var refFeaturegram: Array<DoubleArray> = emptyArray()
    private var refLen: Int = 0
    
    // Live featuregram (chroma vectors)
    private var liveFeaturegram: MutableList<DoubleArray> = mutableListOf()
    
    // Accumulated cost matrix
    private var accumulatedCost: Array<DoubleArray> = emptyArray()
    
    // Parameters
    private var winSize: Int = 0
    private var maxRunCount: Int = 0
    private var diagWeight: Double = 1.0
    
    // State
    private var refIdx: Int = 0
    private var liveIdx: Int = -1
    private var prevStep: String = "---"
    private var runCount: Int = 1
    private var lastRefIdx: Int = 0

    override fun getName() = "OnlineTimeWarpingModule"

    /**
     * Initialize the OnlineTimeWarping algorithm with reference features and parameters.
     */
    @ReactMethod
    fun initialize(refFeatures: ReadableArray, bigC: Int, maxRun: Int, diagW: Double, promise: Promise) {
        try {
            // Parse reference featuregram
            refLen = refFeatures.size()
            refFeaturegram = Array(refLen) { i ->
                val chromaArr = refFeatures.getArray(i)!!
                DoubleArray(chromaArr.size()) { j -> chromaArr.getDouble(j) }
            }
            
            // Initialize accumulated cost matrix with Infinity
            val matrixWidth = refLen * 4
            accumulatedCost = Array(refLen) { DoubleArray(matrixWidth) { Double.POSITIVE_INFINITY } }
            
            // Set parameters
            winSize = bigC
            maxRunCount = maxRun
            diagWeight = diagW
            
            // Reset state
            refIdx = 0
            liveIdx = -1
            prevStep = "---"
            runCount = 1
            lastRefIdx = 0
            liveFeaturegram.clear()
            
            Log.d(TAG, "Initialized with refLen=$refLen, winSize=$winSize, maxRunCount=$maxRunCount, diagWeight=$diagWeight")
            promise.resolve(true)
        } catch (e: Exception) {
            Log.e(TAG, "Error initializing: ${e.message}")
            promise.reject("INIT_ERROR", e)
        }
    }

    /**
     * Insert a new live chroma vector and return the estimated position in the reference.
     */
    @ReactMethod
    fun insert(liveChroma: ReadableArray, promise: Promise) {
        try {
            // Parse live chroma vector
            val chromaVec = DoubleArray(liveChroma.size()) { i -> liveChroma.getDouble(i) }
            liveFeaturegram.add(chromaVec)
            liveIdx += 1
            
            // Update accumulated cost for current window
            val startK = maxOf(0, refIdx - winSize + 1)
            for (k in startK..refIdx) {
                updateAccumulatedCost(k, liveIdx)
            }
            
            // Path finding loop
            while (true) {
                val (step, _, _) = getBestStep()
                
                if (step == "live") break
                
                refIdx = minOf(refIdx + 1, refLen - 1)
                
                // Update accumulated cost for the new refIdx
                val startL = maxOf(liveIdx - winSize + 1, 0)
                for (l in startL..liveIdx) {
                    updateAccumulatedCost(refIdx, l)
                }
                
                if (step == "both") break
            }
            
            // Get current ref position
            var currentRefPosition = refIdx
            
            // Ensure we don't go backwards
            if (currentRefPosition < lastRefIdx) {
                currentRefPosition = lastRefIdx
            }
            lastRefIdx = currentRefPosition
            
            promise.resolve(currentRefPosition)
        } catch (e: Exception) {
            Log.e(TAG, "Error in insert: ${e.message}")
            promise.reject("INSERT_ERROR", e)
        }
    }

    private fun dot(vec1: DoubleArray, vec2: DoubleArray): Double {
        var sum = 0.0
        for (i in vec1.indices) {
            sum += vec1[i] * vec2[i]
        }
        return sum
    }

    private fun argmin(arr: DoubleArray, length: Int): Int {
        var minIdx = 0
        var minVal = arr[0]
        for (i in 1 until length) {
            if (arr[i] < minVal) {
                minVal = arr[i]
                minIdx = i
            }
        }
        return minIdx
    }

    private fun updateAccumulatedCost(refIndex: Int, liveIndex: Int) {
        if (liveIndex >= accumulatedCost[0].size) {
            Log.w(TAG, "Live index $liveIndex exceeds matrix width")
            return
        }
        
        val refVec = refFeaturegram[refIndex]
        val liveVec = liveFeaturegram[liveIndex]
        val cost = 1.0 - dot(refVec, liveVec)
        
        if (refIndex == 0 && liveIndex == 0) {
            accumulatedCost[refIndex][liveIndex] = cost
            return
        }
        
        val steps = mutableListOf<Double>()
        
        if (refIndex > 0 && liveIndex > 0) {
            steps.add(accumulatedCost[refIndex - 1][liveIndex - 1] + diagWeight * cost)
        }
        if (refIndex > 0) {
            steps.add(accumulatedCost[refIndex - 1][liveIndex] + cost)
        }
        if (liveIndex > 0) {
            steps.add(accumulatedCost[refIndex][liveIndex - 1] + cost)
        }
        
        accumulatedCost[refIndex][liveIndex] = steps.minOrNull() ?: cost
    }

    private fun getBestStep(): Triple<String, Int, Int> {
        val rowCosts = DoubleArray(liveIdx + 1) { i -> accumulatedCost[refIdx][i] }
        val colCosts = DoubleArray(refIdx + 1) { i -> accumulatedCost[i][liveIdx] }
        
        var bestT = argmin(rowCosts, rowCosts.size)
        var bestJ = argmin(colCosts, colCosts.size)
        var step: String
        
        if (accumulatedCost[bestJ][liveIdx] < accumulatedCost[refIdx][bestT]) {
            bestT = liveIdx
            step = "live"
        } else if (accumulatedCost[bestJ][liveIdx] > accumulatedCost[refIdx][bestT]) {
            bestJ = refIdx
            step = "ref"
        } else {
            bestT = liveIdx
            bestJ = refIdx
            step = "both"
        }
        
        if (bestT == liveIdx && bestJ == refIdx) step = "both"
        if (liveIdx < winSize) step = "both"
        if (runCount >= maxRunCount) {
            step = if (prevStep == "ref") "live" else "ref"
        }
        
        if (step == "both" || prevStep != step) {
            runCount = 1
        } else {
            runCount += 1
        }
        
        prevStep = step
        
        if (refIdx == refLen - 1) step = "live"
        
        return Triple(step, bestJ, bestT)
    }

    @ReactMethod
    fun reset(promise: Promise) {
        try {
            for (i in accumulatedCost.indices) {
                for (j in accumulatedCost[i].indices) {
                    accumulatedCost[i][j] = Double.POSITIVE_INFINITY
                }
            }
            
            refIdx = 0
            liveIdx = -1
            prevStep = "---"
            runCount = 1
            lastRefIdx = 0
            liveFeaturegram.clear()
            
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("RESET_ERROR", e)
        }
    }

    @ReactMethod
    fun getState(promise: Promise) {
        try {
            val state = com.facebook.react.bridge.Arguments.createMap()
            state.putInt("refIdx", refIdx)
            state.putInt("liveIdx", liveIdx)
            state.putInt("refLen", refLen)
            state.putInt("liveLen", liveFeaturegram.size)
            state.putString("prevStep", prevStep)
            state.putInt("runCount", runCount)
            state.putInt("lastRefIdx", lastRefIdx)
            promise.resolve(state)
        } catch (e: Exception) {
            promise.reject("STATE_ERROR", e)
        }
    }

    /**
     * Get the accumulated cost matrix for backward path computation.
     * Returns a 2D array of costs up to current refIdx and liveIdx.
     */
    @ReactMethod
    fun getAccumulatedCost(promise: Promise) {
        try {
            val result = com.facebook.react.bridge.Arguments.createArray()
            
            // Only return the relevant portion of the matrix (up to refIdx + 1 rows)
            for (i in 0..refIdx) {
                val row = com.facebook.react.bridge.Arguments.createArray()
                // Only return up to liveIdx + 1 columns
                for (j in 0..liveIdx) {
                    row.pushDouble(accumulatedCost[i][j])
                }
                result.pushArray(row)
            }
            
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("GET_COST_ERROR", e)
        }
    }
}
