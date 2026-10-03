// Web Audio API Sound Synthesizer & Competition BGM Engine for Quiz Battle
// 100% royalty-free, self-contained, no external mp3 or streaming dependencies!

class SoundEngine {
    constructor() {
        this.ctx = null;
        this.sfxEnabled = true;
        this.bgmEnabled = true;
        this.bgmVolume = 0.30; // 30% default as requested (25%~35%)
        this.sfxGain = null;
        this.bgmGain = null;
        this.noiseBuffer = null;

        // BGM Sequencer state
        this.bgmRunning = false;
        this.timerId = null;
        this.step = 0;
        this.nextNoteTime = 0.0;
        this.tempo = 124; // 124 BPM driving game-show competition tempo
        this.lookahead = 35.0; // ms
        this.scheduleAheadTime = 0.15; // seconds
    }

    init() {
        if (!this.ctx) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) {
                this.ctx = new AudioCtx();
                this.sfxGain = this.ctx.createGain();
                this.sfxGain.gain.setValueAtTime(1.0, this.ctx.currentTime);
                this.sfxGain.connect(this.ctx.destination);

                this.bgmGain = this.ctx.createGain();
                this.bgmGain.gain.setValueAtTime(this.bgmEnabled ? this.bgmVolume : 0.0, this.ctx.currentTime);
                this.bgmGain.connect(this.ctx.destination);

                this.createNoiseBuffer();
            }
        }
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume().catch(() => {});
        }
    }

    createNoiseBuffer() {
        if (!this.ctx) return;
        const bufferSize = this.ctx.sampleRate * 1.0;
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const output = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            output[i] = Math.random() * 2 - 1;
        }
        this.noiseBuffer = buffer;
    }

    setBgmVolume(val) {
        this.bgmVolume = Math.max(0.0, Math.min(1.0, val));
        if (this.bgmGain && this.ctx) {
            const targetGain = this.bgmEnabled ? this.bgmVolume : 0.0;
            this.bgmGain.gain.setTargetAtTime(targetGain, this.ctx.currentTime, 0.05);
        }
    }

    toggleBgm() {
        this.bgmEnabled = !this.bgmEnabled;
        if (this.bgmGain && this.ctx) {
            const targetGain = this.bgmEnabled ? this.bgmVolume : 0.0;
            this.bgmGain.gain.setTargetAtTime(targetGain, this.ctx.currentTime, 0.05);
        }
        if (this.bgmEnabled && !this.bgmRunning) {
            this.startBgm();
        }
        return this.bgmEnabled;
    }

    toggleSfx() {
        this.sfxEnabled = !this.sfxEnabled;
        if (this.sfxGain && this.ctx) {
            this.sfxGain.gain.setValueAtTime(this.sfxEnabled ? 1.0 : 0.0, this.ctx.currentTime);
        }
        return this.sfxEnabled;
    }

    // ----------------- Competition BGM Sequencer -----------------

    startBgm() {
        this.init();
        if (!this.ctx) return;
        if (this.bgmRunning) return;

        this.bgmRunning = true;
        this.step = 0;
        this.nextNoteTime = this.ctx.currentTime + 0.05;
        this.scheduler();
        console.log("Competition BGM started at 124 BPM, vol:", this.bgmVolume);
    }

    stopBgm() {
        this.bgmRunning = false;
        if (this.timerId) {
            clearTimeout(this.timerId);
            this.timerId = null;
        }
    }

    scheduler() {
        if (!this.bgmRunning || !this.ctx) return;

        while (this.nextNoteTime < this.ctx.currentTime + this.scheduleAheadTime) {
            this.scheduleStep(this.step, this.nextNoteTime);
            const secondsPerStep = (60.0 / this.tempo) / 4.0; // 16th note
            this.nextNoteTime += secondsPerStep;
            this.step = (this.step + 1) % 64; // 4-bar loop (64 steps)
        }

        this.timerId = setTimeout(() => this.scheduler(), this.lookahead);
    }

    scheduleStep(step, time) {
        if (!this.bgmEnabled && this.bgmVolume === 0) return;

        // 1. Kick drum (four on the floor + syncopated accents)
        const isKick = (step % 4 === 0) || (step === 14) || (step === 30) || (step === 46) || (step === 62);
        if (isKick) {
            this.playKick(time);
        }

        // 2. Snare / Clap on beats 4 and 12 of each 16-step bar
        const isSnare = (step % 8 === 4);
        if (isSnare) {
            this.playSnare(time);
        }

        // 3. Hi-hat (steady 16th groove with open hats on offbeats)
        const isHihat = (step % 2 === 0);
        if (isHihat) {
            const isOpen = (step % 4 === 2);
            this.playHihat(time, isOpen);
        }

        // 4. Synth Bass (Driving D minor tension arp: D2, D2, F2, G2, A2, C3, Bb2...)
        const bassNotes = [
            // Bar 1: D Minor pulse
            73.42, 0, 73.42, 0, 87.31, 0, 73.42, 98.00, 73.42, 0, 87.31, 0, 110.00, 0, 98.00, 0,
            // Bar 2: Driving rhythmic shift
            73.42, 0, 73.42, 0, 87.31, 0, 73.42, 98.00, 116.54, 0, 110.00, 0, 98.00, 0, 87.31, 0,
            // Bar 3: F Major / G tension
            87.31, 0, 87.31, 0, 98.00, 0, 98.00, 0, 110.00, 0, 110.00, 0, 130.81, 0, 116.54, 0,
            // Bar 4: Climax buildup
            116.54, 116.54, 110.00, 110.00, 98.00, 98.00, 87.31, 87.31, 73.42, 73.42, 87.31, 98.00, 110.00, 116.54, 130.81, 146.83
        ];
        const bassFreq = bassNotes[step];
        if (bassFreq > 0) {
            this.playSynthBass(bassFreq, time);
        }

        // 5. High suspense chords / synth pluck every 4 steps
        if (step % 8 === 0) {
            const chords = [
                [293.66, 349.23, 440.00], // Dm (D4, F4, A4)
                [293.66, 349.23, 440.00],
                [349.23, 440.00, 523.25], // F (F4, A4, C5)
                [329.63, 392.00, 493.88], // Em/G
                [293.66, 349.23, 440.00],
                [293.66, 349.23, 440.00],
                [233.08, 293.66, 349.23], // Bb
                [220.00, 277.18, 329.63], // A major tension
            ];
            const chord = chords[Math.floor(step / 8) % chords.length];
            chord.forEach(freq => this.playSynthChordNote(freq, time));
        }
    }

    playKick(time) {
        try {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.frequency.setValueAtTime(140, time);
            osc.frequency.exponentialRampToValueAtTime(32, time + 0.08);

            gain.gain.setValueAtTime(0.7, time);
            gain.gain.exponentialRampToValueAtTime(0.001, time + 0.09);

            osc.connect(gain);
            gain.connect(this.bgmGain);

            osc.start(time);
            osc.stop(time + 0.09);
        } catch (e) {}
    }

    playSnare(time) {
        if (!this.noiseBuffer) return;
        try {
            const noise = this.ctx.createBufferSource();
            noise.buffer = this.noiseBuffer;

            const filter = this.ctx.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.setValueAtTime(1200, time);
            filter.Q.setValueAtTime(1.5, time);

            const gain = this.ctx.createGain();
            gain.gain.setValueAtTime(0.35, time);
            gain.gain.exponentialRampToValueAtTime(0.001, time + 0.12);

            noise.connect(filter);
            filter.connect(gain);
            gain.connect(this.bgmGain);

            noise.start(time);
            noise.stop(time + 0.12);
        } catch (e) {}
    }

    playHihat(time, isOpen = false) {
        if (!this.noiseBuffer) return;
        try {
            const noise = this.ctx.createBufferSource();
            noise.buffer = this.noiseBuffer;

            const filter = this.ctx.createBiquadFilter();
            filter.type = 'highpass';
            filter.frequency.setValueAtTime(7500, time);

            const gain = this.ctx.createGain();
            const dur = isOpen ? 0.09 : 0.035;
            gain.gain.setValueAtTime(isOpen ? 0.18 : 0.1, time);
            gain.gain.exponentialRampToValueAtTime(0.001, time + dur);

            noise.connect(filter);
            filter.connect(gain);
            gain.connect(this.bgmGain);

            noise.start(time);
            noise.stop(time + dur);
        } catch (e) {}
    }

    playSynthBass(freq, time) {
        try {
            const osc = this.ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(freq, time);

            const filter = this.ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(800, time);
            filter.frequency.exponentialRampToValueAtTime(150, time + 0.14);

            const gain = this.ctx.createGain();
            gain.gain.setValueAtTime(0.28, time);
            gain.gain.exponentialRampToValueAtTime(0.001, time + 0.14);

            osc.connect(filter);
            filter.connect(gain);
            gain.connect(this.bgmGain);

            osc.start(time);
            osc.stop(time + 0.14);
        } catch (e) {}
    }

    playSynthChordNote(freq, time) {
        try {
            const osc = this.ctx.createOscillator();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, time);

            const gain = this.ctx.createGain();
            gain.gain.setValueAtTime(0.08, time);
            gain.gain.exponentialRampToValueAtTime(0.001, time + 0.4);

            osc.connect(gain);
            gain.connect(this.bgmGain);

            osc.start(time);
            osc.stop(time + 0.4);
        } catch (e) {}
    }

    // ----------------- Sound Effects (SFX) -----------------

    playTone(freq, type = 'sine', duration = 0.15, gainVal = 0.15) {
        if (!this.sfxEnabled) return;
        this.init();
        if (!this.ctx) return;

        try {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, this.ctx.currentTime);

            gain.gain.setValueAtTime(gainVal, this.ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);

            osc.connect(gain);
            gain.connect(this.sfxGain || this.ctx.destination);

            osc.start();
            osc.stop(this.ctx.currentTime + duration);
        } catch (e) {}
    }

    playCountdown(count) {
        if (!this.sfxEnabled) return;
        if (count > 0) {
            this.playTone(440, 'triangle', 0.12, 0.25);
        } else {
            this.playTone(880, 'triangle', 0.35, 0.3);
        }
    }

    playTick() {
        if (!this.sfxEnabled) return;
        this.playTone(600, 'sine', 0.05, 0.1);
    }

    playSubmit() {
        if (!this.sfxEnabled) return;
        this.playTone(523.25, 'triangle', 0.08, 0.18);
    }

    playCorrect() {
        if (!this.sfxEnabled) return;
        this.init();
        if (!this.ctx) return;

        const notes = [523.25, 659.25, 783.99, 1046.50];
        notes.forEach((freq, idx) => {
            setTimeout(() => {
                this.playTone(freq, 'sine', 0.25, 0.25);
            }, idx * 70);
        });
    }

    playWrong() {
        if (!this.sfxEnabled) return;
        this.init();
        if (!this.ctx) return;

        this.playTone(220, 'sawtooth', 0.2, 0.18);
        setTimeout(() => {
            this.playTone(180, 'sawtooth', 0.35, 0.18);
        }, 120);
    }

    playFanfare() {
        if (!this.sfxEnabled) return;
        this.init();
        if (!this.ctx) return;

        const notes = [
            { f: 392.00, d: 0.15, t: 0 },
            { f: 523.25, d: 0.15, t: 150 },
            { f: 659.25, d: 0.15, t: 300 },
            { f: 783.99, d: 0.35, t: 450 },
            { f: 659.25, d: 0.15, t: 800 },
            { f: 783.99, d: 0.15, t: 950 },
            { f: 1046.50, d: 0.8, t: 1100 }
        ];

        notes.forEach(n => {
            setTimeout(() => {
                this.playTone(n.f, 'triangle', n.d, 0.3);
            }, n.t);
        });
    }
}

window.soundEngine = new SoundEngine();
