package com.ni121.companionapp

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import be.tarsos.dsp.pitch.FastYin
import java.util.concurrent.atomic.AtomicBoolean
import java.net.URL
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

class AudioPerformanceModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    
    companion object {
        private const val TAG = "AudioPerformanceModule"
    }
    
    private val SAMPLE_RATE = 44100
    private val PROCESSING_BUFFER_SIZE = 4096
    private val RMS_GATE = 0.005
    private val YIN_PROB_GATE = 0.6 

    private val MIN_BUFFER_SIZE = AudioRecord.getMinBufferSize(
        SAMPLE_RATE,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT
    )

    private var audioRecord: AudioRecord? = null
    private val isRecording = AtomicBoolean(false)
    private var recordingThread: Thread? = null
    
    // Handler for posting events to main thread
    private val mainHandler = Handler(Looper.getMainLooper())
    
    // CENS feature extractor
    private var censUtils: CENSUtils? = null
    
    // DTW logic extracted
    private val dtw = DynamicTimeWarping()

    override fun getName() = "AudioPerformanceModule"

    @ReactMethod
    fun addListener(eventName: String) {
        // Required for NativeEventEmitter
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required for NativeEventEmitter
    }

    /**
     * Initialize DTW by loading audio from a URL and computing CENS natively.
     * This avoids sending 1.2M samples over the React Native bridge.
     * @param audioUrl URL to the WAV audio file
     * @param bigC Window size for DTW
     * @param maxRun Maximum run count for slope constraint
     * @param diagW Diagonal weight
     */
    @ReactMethod
    fun initializeDTWFromUrl(audioUrl: String, bigC: Int, maxRun: Int, diagW: Double, promise: Promise) {
        // Run on background thread to avoid blocking UI
        Thread {
            try {
                Log.d(TAG, "initializeDTWFromUrl: downloading from $audioUrl")
                
                // Download audio file
                val url = URL(audioUrl)
                val connection = url.openConnection()
                connection.connectTimeout = 10000
                connection.readTimeout = 30000
                val inputStream = connection.getInputStream()
                val outputStream = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                var bytesRead: Int
                while (inputStream.read(buffer).also { bytesRead = it } != -1) {
                    outputStream.write(buffer, 0, bytesRead)
                }
                inputStream.close()
                val wavBytes = outputStream.toByteArray()
                Log.d(TAG, "Downloaded ${wavBytes.size} bytes")
                
                // Parse WAV header and extract audio samples
                val audioSamples = parseWavFile(wavBytes)
                Log.d(TAG, "Parsed ${audioSamples.size} audio samples")
                
                // Initialize CENS utils
                val cens = CENSUtils(SAMPLE_RATE, PROCESSING_BUFFER_SIZE)
                censUtils = cens
                
                // Compute number of frames
                val numSamples = audioSamples.size
                val numFrames = numSamples / PROCESSING_BUFFER_SIZE
                Log.d(TAG, "Computing $numFrames CENS frames from audio")
                
                // Compute CENS features for each frame
                val features = Array(numFrames) { frameIdx ->
                    val frameStart = frameIdx * PROCESSING_BUFFER_SIZE
                    val frame = FloatArray(PROCESSING_BUFFER_SIZE) { i ->
                        if (frameStart + i < audioSamples.size) audioSamples[frameStart + i] else 0f
                    }
                    cens.computeCENS(frame)
                }
                
                Log.d(TAG, "Computed ${features.size} reference CENS features")
                
                dtw.initialize(features, bigC, maxRun, diagW)
                
                // Resolve on main thread
                mainHandler.post {
                    promise.resolve(true)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error initializing DTW from URL: ${e.message}")
                e.printStackTrace()
                mainHandler.post {
                    promise.reject("DTW_INIT_ERROR", e.message ?: "Unknown error")
                }
            }
        }.start()
    }

    /**
     * Parse a WAV file and return mono audio samples as float array.
     * Supports 16-bit PCM WAV files.
     */
    private fun parseWavFile(wavBytes: ByteArray): FloatArray {
        val buffer = ByteBuffer.wrap(wavBytes).order(ByteOrder.LITTLE_ENDIAN)
        
        // Read RIFF header
        val riff = ByteArray(4)
        buffer.get(riff)
        if (String(riff) != "RIFF") {
            throw IllegalArgumentException("Not a valid WAV file: missing RIFF header")
        }
        
        buffer.getInt() // file size
        
        val wave = ByteArray(4)
        buffer.get(wave)
        if (String(wave) != "WAVE") {
            throw IllegalArgumentException("Not a valid WAV file: missing WAVE header")
        }
        
        // Find fmt chunk
        var numChannels = 0
        var sampleRate = 0
        var bitsPerSample = 0
        
        while (buffer.hasRemaining()) {
            val chunkId = ByteArray(4)
            buffer.get(chunkId)
            val chunkSize = buffer.getInt()
            val chunkIdStr = String(chunkId)
            
            when (chunkIdStr) {
                "fmt " -> {
                    val audioFormat = buffer.getShort().toInt()
                    numChannels = buffer.getShort().toInt()
                    sampleRate = buffer.getInt()
                    buffer.getInt() // byte rate
                    buffer.getShort() // block align
                    bitsPerSample = buffer.getShort().toInt()
                    
                    // Skip any extra format bytes
                    val extraBytes = chunkSize - 16
                    if (extraBytes > 0) {
                        buffer.position(buffer.position() + extraBytes)
                    }
                    
                    Log.d(TAG, "WAV format: channels=$numChannels, sampleRate=$sampleRate, bits=$bitsPerSample")
                    
                    if (audioFormat != 1) {
                        throw IllegalArgumentException("Only PCM WAV files are supported (got format $audioFormat)")
                    }
                }
                "data" -> {
                    // Read audio data
                    val numSamples = chunkSize / (bitsPerSample / 8) / numChannels
                    Log.d(TAG, "Reading $numSamples samples")
                    
                    val samples = FloatArray(numSamples)
                    
                    if (bitsPerSample == 16) {
                        for (i in 0 until numSamples) {
                            var sum = 0f
                            for (ch in 0 until numChannels) {
                                sum += buffer.getShort().toFloat()
                            }
                            // Convert to mono by averaging channels
                            samples[i] = sum / numChannels
                        }
                    } else if (bitsPerSample == 24) {
                        for (i in 0 until numSamples) {
                            var sum = 0f
                            for (ch in 0 until numChannels) {
                                val b1 = buffer.get().toInt() and 0xFF
                                val b2 = buffer.get().toInt() and 0xFF
                                val b3 = buffer.get().toInt()
                                val sample = (b3 shl 16) or (b2 shl 8) or b1
                                sum += sample.toFloat()
                            }
                            samples[i] = sum / numChannels
                        }
                    } else {
                        throw IllegalArgumentException("Unsupported bit depth: $bitsPerSample")
                    }
                    
                    return samples
                }
                else -> {
                    // Skip unknown chunk
                    buffer.position(buffer.position() + chunkSize)
                }
            }
        }
        
        throw IllegalArgumentException("No data chunk found in WAV file")
    }

    /**
     * Initialize DTW with reference audio data.
     * Computes CENS features natively from raw audio samples.
     * @param audioSamples Raw audio samples as array of doubles
     * @param bigC Window size for DTW
     * @param maxRun Maximum run count for slope constraint
     * @param diagW Diagonal weight
     */
    @ReactMethod
    fun initializeDTWFromAudio(audioSamples: ReadableArray, bigC: Int, maxRun: Int, diagW: Double, promise: Promise) {
        try {
            Log.d(TAG, "initializeDTWFromAudio: received ${audioSamples.size()} samples")
            
            // Initialize CENS utils
            val cens = CENSUtils(SAMPLE_RATE, PROCESSING_BUFFER_SIZE)
            censUtils = cens
            
            // Compute number of frames
            val numSamples = audioSamples.size()
            val numFrames = numSamples / PROCESSING_BUFFER_SIZE
            Log.d(TAG, "Computing $numFrames CENS frames from audio")
            
            // Compute CENS features for each frame
            val features = Array(numFrames) { frameIdx ->
                val frameStart = frameIdx * PROCESSING_BUFFER_SIZE
                val frame = FloatArray(PROCESSING_BUFFER_SIZE) { i ->
                    audioSamples.getDouble(frameStart + i).toFloat()
                }
                cens.computeCENS(frame)
            }
            
            Log.d(TAG, "Computed ${features.size} reference CENS features")
            
            dtw.initialize(features, bigC, maxRun, diagW)
            
            promise.resolve(true)
        } catch (e: Exception) {
            Log.e(TAG, "Error initializing DTW from audio: ${e.message}")
            e.printStackTrace()
            promise.reject("DTW_INIT_ERROR", e)
        }
    }

    /**
     * Initialize DTW with reference features.
     * Must be called before startProcessing() for DTW-based score following.
     * @param refFeatures 2D array of reference CENS features (each row is a 12-dim chroma vector)
     * @param bigC Window size for DTW
     * @param maxRun Maximum run count for slope constraint
     * @param diagW Diagonal weight
     */
    @ReactMethod
    fun initializeDTW(refFeatures: ReadableArray, bigC: Int, maxRun: Int, diagW: Double, promise: Promise) {
        try {
            // Parse reference featuregram
            val refLen = refFeatures.size()
            val features = Array(refLen) { i ->
                val chromaArr = refFeatures.getArray(i)!!
                DoubleArray(chromaArr.size()) { j -> chromaArr.getDouble(j) }
            }
            
            dtw.initialize(features, bigC, maxRun, diagW)
            
            // Initialize CENS utils
            censUtils = CENSUtils(SAMPLE_RATE, PROCESSING_BUFFER_SIZE)
            
            promise.resolve(true)
        } catch (e: Exception) {
            Log.e(TAG, "Error initializing DTW: ${e.message}")
            promise.reject("DTW_INIT_ERROR", e)
        }
    }

    @ReactMethod
    fun startProcessing(promise: Promise) {
        if (isRecording.get()) {
            promise.resolve(null)
            return
        }

        try {
            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                Math.max(MIN_BUFFER_SIZE, PROCESSING_BUFFER_SIZE * 2)
            )

            if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
                promise.reject("AUDIO_INIT_FAIL", "AudioRecord could not be initialized")
                return
            }

            audioRecord?.startRecording()
            isRecording.set(true)
            
            // Reset DTW state for new performance
            if (dtw.isInitialized) {
                dtw.resetState()
            }

            // Start background thread to process audio
            recordingThread = Thread {
                processAudioStream()
            }
            recordingThread?.start()

            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("START_ERROR", e)
        }
    }

    @ReactMethod
    fun stopProcessing(promise: Promise) {
        try {
            isRecording.set(false)
            audioRecord?.stop()
            audioRecord?.release()
            audioRecord = null
            recordingThread?.join()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("STOP_ERROR", e)
        }
    }

    private var lastEventTime: Long = 0
    
    // Silence detection threshold (RMS energy) - higher value requires louder sound
    private val SILENCE_THRESHOLD = 1500f  // Filter soft background noise

    private fun processAudioStream() {
        val buffer = ShortArray(PROCESSING_BUFFER_SIZE)
        val floatBuffer = FloatArray(PROCESSING_BUFFER_SIZE)
        val fastYin = FastYin(SAMPLE_RATE.toFloat(), PROCESSING_BUFFER_SIZE)

        Log.d(TAG, "Processing thread started, DTW initialized: ${dtw.isInitialized}")

        while (isRecording.get()) {
            val readResult = audioRecord?.read(buffer, 0, PROCESSING_BUFFER_SIZE) ?: 0

            if (readResult > 0) {
                // Convert to float and compute RMS energy
                var sumSquares = 0.0
                for (i in 0 until readResult) {
                    floatBuffer[i] = buffer[i].toFloat()
                    sumSquares += floatBuffer[i] * floatBuffer[i]
                }
                val rmsEnergy = kotlin.math.sqrt(sumSquares / readResult).toFloat()

                // Pitch detection
                val detectionResult = fastYin.getPitch(floatBuffer)
                val pitch = detectionResult.pitch
                val probability = detectionResult.probability

                // DTW step (if initialized) - only if audio is not silence
                var refPosition = -1
                if (dtw.isInitialized && censUtils != null) {
                    // Skip DTW if audio is too quiet (silence)
                    if (rmsEnergy >= SILENCE_THRESHOLD) {
                        try {
                            val chromaVec = censUtils!!.computeCENS(floatBuffer)
                            refPosition = dtw.step(chromaVec)
                        } catch (e: Exception) {
                            Log.e(TAG, "DTW step error: ${e.message}")
                        }
                    } else {
                        // Return last known position during silence
                        refPosition = dtw.getLastRefIdx()
                    }
                }

                // Throttle events to ~20 per second
                val currentTime = System.currentTimeMillis()
                if (currentTime - lastEventTime > 50) {
                    sendFrameEvent(refPosition, pitch.toDouble(), probability.toDouble())
                    
                    if (pitch > 0 && probability > YIN_PROB_GATE) {
                        sendEvent("onPitchDetected", pitch.toDouble())
                    }
                    
                    lastEventTime = currentTime
                }
            } else {
                Log.w(TAG, "AudioRecord read returned error or 0: $readResult")
            }
        }
        Log.d(TAG, "Processing thread stopped")
    }

    private fun sendEvent(eventName: String, data: Double) {
        if (reactApplicationContext.hasActiveCatalystInstance()) {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                ?.emit(eventName, data)
        }
    }

    private fun sendFrameEvent(refPosition: Int, pitch: Double, probability: Double) {
        // Post to main thread to ensure thread safety with React Native bridge
        mainHandler.post {
            try {
                if (reactApplicationContext.hasActiveCatalystInstance()) {
                    val params = Arguments.createMap().apply {
                        putInt("refPosition", refPosition)  // DTW-aligned position in reference (-1 if not initialized)
                        putDouble("pitch", pitch)
                        putDouble("probability", probability)
                    }
                    reactApplicationContext
                        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        ?.emit("onAudioFrame", params)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error sending frame event: ${e.message}")
            }
        }
    }
    
    override fun onCatalystInstanceDestroy() {
        super.onCatalystInstanceDestroy()
        try {
            isRecording.set(false)
            audioRecord?.stop()
            audioRecord?.release()
        } catch (e: Exception) {
            // Ignore errors during shutdown
        }
    }
}
