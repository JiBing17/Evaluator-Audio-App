package com.ni121.companionapp

import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.Arguments
import be.tarsos.dsp.util.fft.FFT
import be.tarsos.dsp.util.fft.HannWindow
import kotlin.FloatArray
import kotlin.Array
import kotlin.Float

class FFTModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    var cFC: Array<FloatArray> = emptyArray()
    
    // Pre-allocated FFT and buffers to avoid per-call allocations
    private var fftLib: FFT? = null
    private var lastFftSize: Int = 0
    private var signalBuffer: FloatArray? = null
    private var amplitudesBuffer: FloatArray? = null
    private val chromaVec = FloatArray(12)

    override fun getName() = "FFTModule"

    @ReactMethod
    fun setcFC(cFC: ReadableArray, promise: Promise) {
        try {
            this.cFC = Array(cFC.size()) { FloatArray(cFC.getArray(0)!!.size()) }

            for (i in 0..(cFC.size() - 1)) {
                for (j in 0..(cFC.getArray(0)!!.size() - 1)) {
                    this.cFC[i][j] = cFC.getArray(i)!!.getDouble(j).toFloat();
                }
            }

            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("Error setting cFC", e)
        }
    }

    @ReactMethod
    fun fft(signalDataIn: ReadableArray, promise: Promise) {
        try {
            val size = signalDataIn.size()
            
            // Lazily initialize or reinitialize FFT if size changed
            if (fftLib == null || lastFftSize != size) {
                fftLib = FFT(size, HannWindow())
                lastFftSize = size
                signalBuffer = FloatArray(size)
                amplitudesBuffer = FloatArray(size / 2)
            }
            
            val signalData = signalBuffer!!
            val amplitudes = amplitudesBuffer!!

            // Copy input to buffer
            for (i in 0 until size) {
                signalData[i] = signalDataIn.getDouble(i).toFloat()
            }

            fftLib!!.forwardTransform(signalData)
            fftLib!!.modulus(signalData, amplitudes)

            // Compute chroma
            for (i in 0..11) {
                var sum = 0f
                for (j in amplitudes.indices) {
                    sum += this.cFC[i][j] * amplitudes[j] * amplitudes[j]
                }
                chromaVec[i] = sum
            }

            val result = Arguments.fromArray(chromaVec)
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("FFT_ERROR", e)
        }
    }

    @ReactMethod
    fun dot(vec1: ReadableArray, vec2: ReadableArray, promise: Promise) {
        try {
            assert(vec1.size() == vec2.size())

            var sum = 0.0

            for (i in 0..(vec1.size() - 1)) {
                sum += vec1.getDouble(i) * vec2.getDouble(i)
            }

            promise.resolve(sum)
        } catch (e: Exception) {
            promise.reject("DOT_ERROR", e)
        }
    }
}
