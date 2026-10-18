#!/usr/bin/env python3
"""
Ownership-first local TTS server for Helix voice proxy.

Exposes:
  GET  /health
  POST /speak  (JSON body: {"text":"..."}; returns audio/wav bytes)

Uses NeMo FastPitch + HiFi-GAN checkpoints when available.
Optional sample fallback can be enabled for transport-path smoke tests.
"""

from __future__ import annotations

import io
import json
import os
import sys
import traceback
import wave
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


def _env(name: str, default: str) -> str:
    return str(os.getenv(name, default)).strip()


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    value = raw.strip().lower()
    return value in ("1", "true", "yes", "on")


HOST = _env("LOCAL_TTS_HOST", "127.0.0.1")
PORT = int(_env("LOCAL_TTS_PORT", "5051"))
FASTPITCH_PATH = Path(_env("LOCAL_TTS_FASTPITCH_PATH", "bundles/dottie_default/voice_bundle/fastpitch.nemo"))
HIFIGAN_PATH = Path(_env("LOCAL_TTS_HIFIGAN_PATH", "bundles/dottie_default/voice_bundle/hifigan.nemo"))
SAMPLE_PATH = Path(_env("LOCAL_TTS_SAMPLE_PATH", "bundles/dottie_default/voice_bundle/sample.wav"))
ALLOW_SAMPLE_FALLBACK = _env_bool("LOCAL_TTS_ENABLE_SAMPLE_FALLBACK", False)
DEVICE_POLICY = _env("LOCAL_TTS_DEVICE", "auto").lower()


@dataclass
class BackendState:
    mode: str
    sample_rate_hz: int
    error_code: str | None
    error_message: str | None
    fastpitch_exists: bool
    hifigan_exists: bool
    sample_exists: bool
    model: Any = None
    vocoder: Any = None
    torch: Any = None


def _pcm16_wav_bytes(audio_tensor: Any, sample_rate_hz: int, torch_mod: Any) -> bytes:
    # audio tensor expected in [-1, 1], shape [T] or [1, T]
    torch = audio_tensor.__class__.__module__.split(".")[0]
    if torch != "torch":
        raise RuntimeError("unexpected_audio_tensor_type")
    arr = audio_tensor.detach().cpu().flatten().clamp(-1.0, 1.0)
    pcm = (arr * 32767.0).to(dtype=torch_mod.int16)
    # Avoid hard dependency on numpy; fallback to Python array conversion.
    try:
        pcm_bytes = pcm.numpy().tobytes()
    except Exception:
        pcm_bytes = b"".join(int(v).to_bytes(2, byteorder="little", signed=True) for v in pcm.tolist())
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate_hz))
        wf.writeframes(pcm_bytes)
    return buf.getvalue()


def _load_backend() -> BackendState:
    fastpitch_exists = FASTPITCH_PATH.exists()
    hifigan_exists = HIFIGAN_PATH.exists()
    sample_exists = SAMPLE_PATH.exists()

    if not fastpitch_exists or not hifigan_exists:
        if ALLOW_SAMPLE_FALLBACK and sample_exists:
            return BackendState(
                mode="sample_fallback",
                sample_rate_hz=22050,
                error_code=None,
                error_message=None,
                fastpitch_exists=fastpitch_exists,
                hifigan_exists=hifigan_exists,
                sample_exists=sample_exists,
            )
        return BackendState(
            mode="unavailable",
            sample_rate_hz=22050,
            error_code="tts_bundle_missing",
            error_message="fastpitch/hifigan bundle files not found",
            fastpitch_exists=fastpitch_exists,
            hifigan_exists=hifigan_exists,
            sample_exists=sample_exists,
        )

    try:
        import torch  # type: ignore
        from nemo.collections.tts.models import FastPitchModel, HifiGanModel  # type: ignore

        model = FastPitchModel.restore_from(restore_path=str(FASTPITCH_PATH), map_location="cpu")
        vocoder = HifiGanModel.restore_from(restore_path=str(HIFIGAN_PATH), map_location="cpu")
        model.eval()
        vocoder.eval()

        if DEVICE_POLICY in ("cuda", "gpu"):
            if not torch.cuda.is_available():
                raise RuntimeError("cuda_requested_but_unavailable")
            model = model.cuda()
            vocoder = vocoder.cuda()
        elif DEVICE_POLICY == "auto" and torch.cuda.is_available():
            model = model.cuda()
            vocoder = vocoder.cuda()

        sample_rate_hz = int(getattr(vocoder, "sample_rate", 22050))
        return BackendState(
            mode="nemo",
            sample_rate_hz=sample_rate_hz,
            error_code=None,
            error_message=None,
            fastpitch_exists=fastpitch_exists,
            hifigan_exists=hifigan_exists,
            sample_exists=sample_exists,
            model=model,
            vocoder=vocoder,
            torch=torch,
        )
    except Exception as exc:
        if ALLOW_SAMPLE_FALLBACK and sample_exists:
            return BackendState(
                mode="sample_fallback",
                sample_rate_hz=22050,
                error_code=None,
                error_message=None,
                fastpitch_exists=fastpitch_exists,
                hifigan_exists=hifigan_exists,
                sample_exists=sample_exists,
            )
        return BackendState(
            mode="unavailable",
            sample_rate_hz=22050,
            error_code="nemo_runtime_unavailable",
            error_message=f"{type(exc).__name__}: {exc}",
            fastpitch_exists=fastpitch_exists,
            hifigan_exists=hifigan_exists,
            sample_exists=sample_exists,
        )


STATE = _load_backend()


class TtsHandler(BaseHTTPRequestHandler):
    server_version = "CasimirLocalTTS/1"

    def _write_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0"))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def _synthesize_nemo(self, text: str) -> bytes:
        assert STATE.model is not None and STATE.vocoder is not None and STATE.torch is not None
        with STATE.torch.no_grad():
            tokens = STATE.model.parse(text)
            spectrogram = STATE.model.generate_spectrogram(tokens=tokens)
            audio = STATE.vocoder.convert_spectrogram_to_audio(spec=spectrogram)
            return _pcm16_wav_bytes(audio, STATE.sample_rate_hz, STATE.torch)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self._write_json(404, {"error": "not_found"})
            return
        self._write_json(
            200,
            {
                "ok": True,
                "mode": STATE.mode,
                "sample_rate_hz": STATE.sample_rate_hz,
                "fastpitch_path": str(FASTPITCH_PATH),
                "hifigan_path": str(HIFIGAN_PATH),
                "sample_path": str(SAMPLE_PATH),
                "fastpitch_exists": STATE.fastpitch_exists,
                "hifigan_exists": STATE.hifigan_exists,
                "sample_exists": STATE.sample_exists,
                "allow_sample_fallback": ALLOW_SAMPLE_FALLBACK,
                "error_code": STATE.error_code,
                "error_message": STATE.error_message,
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/speak":
            self._write_json(404, {"error": "not_found"})
            return
        try:
            payload = self._read_json()
        except Exception:
            self._write_json(400, {"error": "voice_invalid_request", "message": "invalid json payload"})
            return

        text = str(payload.get("text", "")).strip()
        if not text:
            self._write_json(400, {"error": "voice_invalid_request", "message": "text is required"})
            return

        trace_id = payload.get("traceId")

        if STATE.mode == "unavailable":
            self._write_json(
                503,
                {
                    "error": "voice_unavailable",
                    "message": "local nemo tts backend unavailable",
                    "details": {
                        "code": STATE.error_code,
                        "reason": STATE.error_message,
                    },
                    "traceId": trace_id,
                },
            )
            return

        try:
            if STATE.mode == "sample_fallback":
                wav_bytes = SAMPLE_PATH.read_bytes()
                sample_rate = 22050
                provider = "local-sample-fallback"
            else:
                wav_bytes = self._synthesize_nemo(text)
                sample_rate = STATE.sample_rate_hz
                provider = "local-nemo"
        except Exception as exc:
            self._write_json(
                502,
                {
                    "error": "voice_backend_error",
                    "message": "tts synthesis failed",
                    "details": {
                        "type": type(exc).__name__,
                        "reason": str(exc),
                    },
                    "traceId": trace_id,
                },
            )
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav_bytes)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Voice-Provider", provider)
        self.send_header("X-Voice-Profile", "dottie_default")
        self.send_header("X-Audio-Sample-Rate", str(sample_rate))
        self.end_headers()
        self.wfile.write(wav_bytes)

    def log_message(self, format: str, *args: Any) -> None:
        sys.stdout.write("[local-tts] " + (format % args) + "\n")
        sys.stdout.flush()


def main() -> int:
    print(
        json.dumps(
            {
                "service": "local_nemo_tts",
                "host": HOST,
                "port": PORT,
                "mode": STATE.mode,
                "fastpitch_path": str(FASTPITCH_PATH),
                "hifigan_path": str(HIFIGAN_PATH),
                "sample_path": str(SAMPLE_PATH),
                "allow_sample_fallback": ALLOW_SAMPLE_FALLBACK,
                "error_code": STATE.error_code,
                "error_message": STATE.error_message,
            },
            ensure_ascii=True,
        ),
        flush=True,
    )
    server = ThreadingHTTPServer((HOST, PORT), TtsHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    except Exception:
        traceback.print_exc()
        return 1
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
