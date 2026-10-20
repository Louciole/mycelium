/**
 * Mic processing on the audio thread: input volume + voice detection gate.
 * A worklet and not a timer on the page: timers are throttled in a background
 * tab (1/s, then 1/min), which is where the app sits during most calls.
 *
 * Settings come through the port: {volume (0..2), mode ('off' | 'auto' | 'manual'),
 * threshold (dB, manual mode)}. Levels go back through it about 45 times a second:
 * {level (dB, after the volume), threshold (dB, the one in use), open}.
 */

const REPORT_EVERY = 8;                          // blocks of 128 samples (~21 ms at 48 kHz)
const HOLD_S = 0.3;                              // stay open through the gaps between words
const ATTACK_S = 0.005;
const RELEASE_S = 0.08;
// Auto mode: the threshold sits AUTO_MARGIN dB above the background noise, which
// is followed down fast and up slowly (speech must not raise it)
const AUTO_MARGIN = 12;
const AUTO_MIN = -70;
const AUTO_MAX = -32;
const FLOOR_RISE = 0.002;                        // dB per block (~0.75 dB/s)

class VoiceGate extends AudioWorkletProcessor {
    constructor() {
        super();
        this.volume = 1;
        this.mode = 'auto';
        this.manualThreshold = -50;
        this.floor = -60;
        this.gain = 0;
        this.open = false;
        this.holdLeft = 0;
        this.peak = -Infinity;
        this.blocks = 0;
        this.holdBlocks = Math.round(HOLD_S * sampleRate / 128);
        this.attack = 1 - Math.exp(-1 / (ATTACK_S * sampleRate));
        this.release = 1 - Math.exp(-1 / (RELEASE_S * sampleRate));
        this.port.onmessage = ({ data }) => {
            if (typeof data.volume === 'number') this.volume = data.volume;
            if (data.mode) this.mode = data.mode;
            if (typeof data.threshold === 'number') this.manualThreshold = data.threshold;
        };
    }

    threshold() {
        if (this.mode === 'manual') return this.manualThreshold;
        return Math.min(AUTO_MAX, Math.max(AUTO_MIN, this.floor + AUTO_MARGIN));
    }

    process(inputs, outputs) {
        const input = inputs[0];
        const out = outputs[0][0];
        if (!input.length) {                          // no source connected (yet)
            out.fill(0);
            return true;
        }
        const n = out.length;
        const channels = input.length;
        let sum = 0;
        for (let i = 0; i < n; i++) {
            let s = 0;
            for (let c = 0; c < channels; c++) s += input[c][i];
            s = (s / channels) * this.volume;
            out[i] = s;
            sum += s * s;
        }
        const level = 10 * Math.log10(sum / n + 1e-12);   // RMS, dBFS

        if (level < this.floor) this.floor += (level - this.floor) * 0.2;
        else this.floor += Math.min(level - this.floor, FLOOR_RISE);

        const threshold = this.threshold();
        if (this.mode === 'off' || level >= threshold) {
            this.open = true;
            this.holdLeft = this.holdBlocks;
        } else if (this.holdLeft > 0) {
            this.holdLeft--;
        } else {
            this.open = false;
        }

        const target = this.open ? 1 : 0;
        const coef = this.open ? this.attack : this.release;
        let g = this.gain;
        for (let i = 0; i < n; i++) {
            g += (target - g) * coef;
            out[i] *= g;
        }
        this.gain = g;

        this.peak = Math.max(this.peak, level);
        if (++this.blocks >= REPORT_EVERY) {
            this.port.postMessage({ level: this.peak, threshold, open: this.open });
            this.peak = -Infinity;
            this.blocks = 0;
        }
        return true;
    }
}

registerProcessor('voice-gate', VoiceGate);
