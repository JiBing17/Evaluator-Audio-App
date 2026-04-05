package com.ni121.companionapp

import android.util.Log

class DynamicTimeWarping {
    companion object {
        private const val TAG = "DynamicTimeWarping"
    }

    private var refFeaturegram: Array<DoubleArray> = emptyArray()
    private var refLen: Int = 0
    private var liveFeaturegram: MutableList<DoubleArray> = mutableListOf()
    private var accumulatedCost: Array<DoubleArray> = emptyArray()
    private var winSize: Int = 50
    private var maxRunCount: Int = 3
    private var diagWeight: Double = 0.75
    private var refIdx: Int = 0
    private var liveIdx: Int = -1
    private var prevStep: String = "---"
    private var runCount: Int = 1
    private var lastRefIdx: Int = 0
    var isInitialized: Boolean = false
        private set

    fun initialize(refFeatures: Array<DoubleArray>, bigC: Int, maxRun: Int, diagW: Double) {
        refLen = refFeatures.size
        refFeaturegram = refFeatures
        
        val matrixWidth = refLen * 4
        accumulatedCost = Array(refLen) { DoubleArray(matrixWidth) { Double.POSITIVE_INFINITY } }
        
        winSize = bigC
        maxRunCount = maxRun
        diagWeight = diagW
        
        isInitialized = true
        resetState()
        
        Log.d(TAG, "DTW initialized with refLen=$refLen, winSize=$winSize, maxRunCount=$maxRunCount")
    }

    fun fastReset() {
        resetState()
    }

    fun resetState() {
        if (!isInitialized) return
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
    }

    fun step(chromaVec: DoubleArray): Int {
        if (!isInitialized || refFeaturegram.isEmpty() || refLen == 0) return -1
        
        liveFeaturegram.add(chromaVec)
        liveIdx += 1
        
        if (liveIdx >= accumulatedCost[0].size) {
            Log.w(TAG, "Live index $liveIdx exceeds matrix width, returning last position")
            return lastRefIdx
        }
        
        val startK = maxOf(0, refIdx - winSize + 1)
        for (k in startK..minOf(refIdx, refLen - 1)) {
            updateAccumulatedCost(k, liveIdx)
        }
        
        var iterations = 0
        val maxIterations = refLen
        while (iterations < maxIterations) {
            iterations++
            val (step, _, _) = getBestStep()
            
            if (step == "live") break
            
            refIdx = minOf(refIdx + 1, refLen - 1)
            
            val startL = maxOf(liveIdx - winSize + 1, 0)
            for (l in startL..liveIdx) {
                updateAccumulatedCost(refIdx, l)
            }
            
            if (step == "both") break
        }
        
        var currentRefPosition = refIdx
        if (currentRefPosition < lastRefIdx) {
            currentRefPosition = lastRefIdx
        }
        lastRefIdx = currentRefPosition
        
        return currentRefPosition
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
        if (liveIdx < 0 || refIdx < 0 || refIdx >= refLen) {
            return Triple("live", refIdx, liveIdx)
        }
        if (liveIdx >= accumulatedCost[0].size) {
            return Triple("live", refIdx, liveIdx)
        }
        
        val rowCosts = DoubleArray(liveIdx + 1) { i -> 
            if (i < accumulatedCost[refIdx].size) accumulatedCost[refIdx][i] else Double.POSITIVE_INFINITY
        }
        val colCosts = DoubleArray(refIdx + 1) { i -> 
            if (liveIdx < accumulatedCost[i].size) accumulatedCost[i][liveIdx] else Double.POSITIVE_INFINITY
        }
        
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

    fun getLastRefIdx(): Int = lastRefIdx
}