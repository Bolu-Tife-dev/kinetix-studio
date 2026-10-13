#!/usr/bin/env python3
"""
Kinetix Studio — audio beat/transient analysis sidecar.

Usage:
    python beat_analysis.py <input_audio.wav> [--json-out <path>]

Prints a JSON document to stdout:
    {
      "engine": "librosa",
      "sampleRate": 22050,
      "durationSec": 12.34,
      "tempoBpm": 128.0,
      "beatsMs": [0, 468, 937, ...],
      "onsetsMs": [12, 470, ...],
      "energyProfile": [0.01, 0.4, ...]
    }

Requires: librosa, numpy  (pip install librosa numpy)
Falls back to a pure-numpy energy detector if librosa is unavailable.
"""
import sys
import json
import argparse
import wave
import struct
import math


def read_wav_mono(path):
    with wave.open(path, "rb") as wf:
        rate = wf.getframerate()
        n = wf.getnframes()
        width = wf.getsampwidth()
        channels = wf.getnchannels()
        raw = wf.readframes(n)
    if width == 2:
        fmt = "<%dh" % (len(raw) // 2)
        samples = struct.unpack(fmt, raw)
        samples = [s / 32768.0 for s in samples]
    elif width == 1:
        samples = [(b - 128) / 128.0 for b in raw]
    elif width == 4:
        fmt = "<%di" % (len(raw) // 4)
        samples = [s / 2147483648.0 for s in struct.unpack(fmt, raw)]
    else:
        raise ValueError("Unsupported sample width: %d" % width)
    if channels > 1:
        mono = []
        for i in range(0, len(samples), channels):
            mono.append(sum(samples[i:i + channels]) / channels)
        samples = mono
    return rate, samples


def analyze_with_librosa(path):
    import numpy as np
    import librosa

    y, sr = librosa.load(path, sr=22050, mono=True)
    duration = float(len(y) / sr)
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units="frames")
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    onset_frames = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr, units="frames")
    onset_times = librosa.frames_to_time(onset_frames, sr=sr)
    tempo_val = float(np.atleast_1d(tempo)[0]) if len(np.atleast_1d(tempo)) else 0.0
    if tempo_val <= 0 and len(beat_times) > 1:
        tempo_val = 60.0 / float(np.median(np.diff(beat_times)))
    # Downsampled energy profile for UI waveform strips (128 buckets).
    buckets = 128
    step = max(1, len(y) // buckets)
    profile = []
    for i in range(0, len(y), step):
        chunk = y[i:i + step]
        profile.append(float(np.sqrt(np.mean(chunk ** 2))) if len(chunk) else 0.0)
    peak = max(profile) if profile else 1.0
    if peak > 0:
        profile = [round(v / peak, 4) for v in profile]
    return {
        "engine": "librosa",
        "sampleRate": sr,
        "durationSec": round(duration, 4),
        "tempoBpm": round(tempo_val, 2),
        "beatsMs": [round(float(t) * 1000.0, 2) for t in beat_times],
        "onsetsMs": [round(float(t) * 1000.0, 2) for t in onset_times],
        "energyProfile": profile,
    }


def analyze_fallback(path):
    """Pure-python energy-onset detector used when librosa is not installed."""
    sr, y = read_wav_mono(path)
    duration = len(y) / float(sr)
    hop = max(1, int(sr * 0.010))  # 10 ms hop
    energies = []
    i = 0
    while i + hop <= len(y):
        chunk = y[i:i + hop]
        e = sum(s * s for s in chunk) / len(chunk)
        energies.append(e)
        i += hop
    if not energies:
        return {
            "engine": "fallback-energy",
            "sampleRate": sr,
            "durationSec": round(duration, 4),
            "tempoBpm": 0.0,
            "beatsMs": [],
            "onsetsMs": [],
            "energyProfile": [],
        }
    # Smooth and normalize.
    smoothed = []
    for idx, e in enumerate(energies):
        lo = max(0, idx - 2)
        hi = min(len(energies), idx + 3)
        smoothed.append(sum(energies[lo:hi]) / (hi - lo))
    peak = max(smoothed) or 1.0
    norm = [e / peak for e in smoothed]
    # Adaptive threshold onflux detection.
    mean = sum(norm) / len(norm)
    thresh = mean * 1.6 + 0.05
    min_gap = int(0.18 / 0.010)  # 180 ms refractory
    onsets = []
    last = -min_gap
    for idx in range(1, len(norm) - 1):
        if norm[idx] > thresh and norm[idx] >= norm[idx - 1] and norm[idx] >= norm[idx + 1]:
            if idx - last >= min_gap:
                onsets.append(idx * 0.010 * 1000.0)
                last = idx
    # Estimate tempo from median inter-onset interval.
    tempo = 0.0
    if len(onsets) >= 3:
        intervals = [onsets[k + 1] - onsets[k] for k in range(len(onsets) - 1)]
        intervals.sort()
        median = intervals[len(intervals) // 2]
        if median > 0:
            tempo = 60000.0 / median
            while tempo > 180:
                tempo /= 2.0
            while tempo < 70 and tempo > 0:
                tempo *= 2.0
    buckets = 128
    step = max(1, len(norm) // buckets)
    profile = []
    for b in range(buckets):
        chunk = norm[b * step:(b + 1) * step]
        profile.append(round(max(chunk) if chunk else 0.0, 4))
    return {
        "engine": "fallback-energy",
        "sampleRate": sr,
        "durationSec": round(duration, 4),
        "tempoBpm": round(tempo, 2),
        "beatsMs": [round(o, 2) for o in onsets],
        "onsetsMs": [round(o, 2) for o in onsets],
        "energyProfile": profile,
    }


def main():
    parser = argparse.ArgumentParser(description="Kinetix beat analysis sidecar")
    parser.add_argument("input", help="Path to a WAV audio file")
    parser.add_argument("--json-out", dest="json_out", default=None, help="Also write JSON to this path")
    parser.add_argument("--engine", choices=["auto", "librosa", "fallback"], default="auto")
    args = parser.parse_args()

    result = None
    if args.engine in ("auto", "librosa"):
        try:
            result = analyze_with_librosa(args.input)
        except ImportError:
            if args.engine == "librosa":
                print(json.dumps({"error": "librosa not installed"}))
                sys.exit(2)
    if result is None:
        result = analyze_fallback(args.input)

    payload = json.dumps(result)
    if args.json_out:
        with open(args.json_out, "w", encoding="utf8") as fh:
            fh.write(payload)
    print(payload)


if __name__ == "__main__":
    main()
