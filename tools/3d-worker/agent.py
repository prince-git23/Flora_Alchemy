"""FLORA ALCHEMY REMOTE GPU AGENT — TripoSR on the owner's PC, driving itself.

WHY THIS FILE EXISTS
    Phase 4's worker (`worker.py`) is DRIVEN by the backend over loopback. That
    works on one machine and cannot work in production: the API runs on Render,
    the GPU lives on the owner's Windows PC, and Render must never dial a
    loopback/LAN address — nor should an inference port ever face the internet.

    This agent reverses the direction and reuses the SAME inference engine:

        backend (Render)  ◀──HTTPS polls/claims/uploads──  agent.py (this PC)

    The backend holds the queue in MongoDB (a job is QUEUED until claimed); the
    agent claims ONE job at a time (limited VRAM), downloads ONLY that job's
    accepted reference images, runs the real TripoSR engine from `worker.py`,
    uploads the GLB bytes, and heartbeats throughout. The backend validates the
    bytes, stores them privately, measures quality — and a HUMAN still approves
    the model before any customer sees it. Nothing about the approval pipeline
    changes; this file only supplies genuine bytes from a genuine GPU.

SECURITY MODEL
    · THREE_WORKER_AGENT_TOKEN — a long shared MACHINE secret, sent as a Bearer
      token on every request. It is never logged, never printed (not even by
      --diagnose), and never written to disk.
    · x-agent-lease — a PER-JOB secret the server mints when this agent claims
      a job. Every job-scoped call (input, result, failure, release) carries it,
      so a leaked machine token alone cannot touch a job it has not claimed.
    · The API base must be HTTPS (loopback HTTP is allowed for local testing).
    · The agent exposes NO PORT. worker.py's /generate server is never started;
      nothing can call into this machine.

RELIABILITY
    · One inference at a time, serialised behind the engine's own lock.
    · Heartbeats renew the job lease; the server's answer is authoritative — a
      cancellation or a lost lease aborts the local run immediately.
    · Transient network failures back off exponentially and re-poll; a result
      upload is IDEMPOTENT (the server answers `duplicate` for a repeat), and
      if the model cannot be delivered before the lease is lost the GLB is
      saved to the work directory for manual recovery, never silently dropped.

USAGE
    set THREE_WORKER_AGENT_URL=https://flora-alchemy.onrender.com/api
    set THREE_WORKER_AGENT_TOKEN=<the same secret as the backend>
    python agent.py --triposr-home ..\\..\\..\\flora-3d\\TripoSR --device cuda:0

    python agent.py --diagnose      # CUDA/model/connection report, no credentials
    python agent.py --once          # handle exactly one job, then exit (testing)
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# The agent reuses the Phase 4 engine wholesale: model loading, CUDA handling,
# inference, GLB export and self-inspection all live in worker.py.
import worker as worker_mod  # noqa: E402

AGENT_VERSION = "1.0.0"
TOKEN_MIN_LENGTH = 16
LEASE_HEADER = "X-Agent-Lease"
MAX_BACKOFF_SECONDS = 60
RESULT_UPLOAD_ATTEMPTS = 10


class AgentConfig:
    """Everything read from the environment/CLI. The token is never repr()'d."""

    def __init__(self, args) -> None:
        self.api_base = (args.api_url or os.environ.get("THREE_WORKER_AGENT_URL", "")).rstrip("/")
        self.token = args.token or os.environ.get("THREE_WORKER_AGENT_TOKEN", "")
        self.worker_id = (
            args.worker_id
            or os.environ.get("THREE_WORKER_AGENT_ID", "")
            or socket.gethostname()
            or "gpu-agent"
        )
        self.worker_id = "".join(c if c.isalnum() or c in "._-" else "-" for c in self.worker_id)[:64]
        self.poll_wait = max(0, min(int(args.poll_wait), 20))
        self.idle_poll_seconds = max(2.0, float(args.idle_poll_seconds))

    def validate(self) -> None:
        problems = []
        if not self.api_base:
            problems.append(
                "THREE_WORKER_AGENT_URL is not set — the /api base of the deployed backend "
                "(e.g. https://flora-alchemy.onrender.com/api)."
            )
        else:
            scheme = self.api_base.split(":", 1)[0]
            host = self.api_base.split("/", 3)[2].split(":")[0] if "//" in self.api_base else ""
            loopback = host in ("127.0.0.1", "localhost", "::1")
            if scheme != "https" and not loopback:
                problems.append("THREE_WORKER_AGENT_URL must be HTTPS (loopback HTTP is allowed for local tests).")
        if len(self.token) < TOKEN_MIN_LENGTH:
            problems.append(
                f"THREE_WORKER_AGENT_TOKEN is missing or shorter than {TOKEN_MIN_LENGTH} characters — "
                "it must be the SAME long random secret the backend has."
            )
        if problems:
            raise SystemExit("[agent] configuration problem:\n  - " + "\n  - ".join(problems))


class Backend:
    """The agent's client for the deployed API's restricted /3d/agent surface."""

    def __init__(self, config: AgentConfig) -> None:
        self.base = f"{config.api_base}/3d/agent"
        self.token = config.token
        self.worker_id = config.worker_id
        self.last_ok_at: Optional[float] = None
        self.last_error: str = ""
        self.connected = False

    def _request(
        self,
        method: str,
        path: str,
        payload: Optional[dict] = None,
        raw: Optional[bytes] = None,
        lease: str = "",
        timeout: float = 30.0,
    ):
        url = f"{self.base}{path}"
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        if lease:
            headers[LEASE_HEADER] = lease
        body = None
        if raw is not None:
            body = raw
            headers["Content-Type"] = "model/gltf-binary"
        elif payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                text = response.read().decode("utf-8", "replace")
                self.last_ok_at = time.time()
                self.connected = True
                self.last_error = ""
                return response.status, json.loads(text) if text else {}
        except urllib.error.HTTPError as err:
            text = err.read().decode("utf-8", "replace")
            self.connected = True  # the server ANSWERED; that is not a network failure
            self.last_error = f"HTTP {err.code}"
            try:
                return err.code, json.loads(text)
            except Exception:
                return err.code, {"success": False, "message": text[:300]}
        except Exception as err:  # URLError, timeout, DNS, TLS…
            self.connected = False
            self.last_error = f"{type(err).__name__}: {err}"
            raise

    # -- protocol ----------------------------------------------------------
    def heartbeat(self, state: str, current_job: Optional[dict], engine) -> dict:
        body = {
            "workerId": self.worker_id,
            "state": state,
            "modelLoaded": engine.model is not None,
            "model": worker_mod.MODEL_NAME,
            "modelVersion": worker_mod.MODEL_VERSION,
            "device": engine.device,
            "gpuName": engine.gpu_name,
            "vramTotalMb": engine.vram_total_mb,
            "agentVersion": AGENT_VERSION,
        }
        if current_job:
            body["currentJobId"] = current_job["id"]
            body["leaseToken"] = current_job["lease"]["token"]
        status, data = self._request("POST", "/heartbeat", payload=body, timeout=20.0)
        if status != 200:
            raise RuntimeError(f"heartbeat refused (HTTP {status}: {data.get('message') or data.get('code')})")
        return data

    def claim(self, worker_id: str, wait_seconds: int) -> Optional[dict]:
        status, data = self._request(
            "POST",
            "/jobs/claim",
            payload={"workerId": worker_id, "waitSeconds": wait_seconds},
            timeout=wait_seconds + 30.0 if wait_seconds else 30.0,
        )
        if status == 401:
            raise SystemExit("[agent] the server rejected the machine token — fix THREE_WORKER_AGENT_TOKEN on BOTH sides.")
        if status == 503:
            raise SystemExit(f"[agent] the server is not configured for an agent: {data.get('message')}")
        if status != 200:
            raise RuntimeError(f"claim refused (HTTP {status}: {data.get('message')})")
        return data.get("job")

    def job_input(self, job_id: str, lease: str) -> dict:
        status, data = self._request("GET", f"/jobs/{job_id}/input", lease=lease, timeout=60.0)
        if status != 200:
            raise RuntimeError(f"input refused (HTTP {status}: {data.get('code')})")
        return data

    def upload_result(
        self, job_id: str, lease: str, task_id: str, glb: bytes, stats: Optional[dict] = None
    ) -> tuple:
        # Diagnostic facts (which photograph was used, its mask, component
        # cleanup) ride along as a bounded query parameter. They are DIAGNOSTICS:
        # oversized or malformed stats are dropped, never allowed to fail the
        # delivery of bytes the server can validate itself. The SERVER re-filters
        # every field before anything touches a record.
        query = f"taskId={urllib.parse.quote(task_id)}"
        if stats:
            try:
                encoded = urllib.parse.quote(json.dumps(stats, default=str))
                if len(encoded) <= 6_000:
                    query = f"{query}&stats={encoded}"
                else:
                    print("[agent] result stats exceeded 6 KB; sending the GLB without them", flush=True)
            except Exception as err:
                print(f"[agent] result stats could not be encoded ({err}); sending the GLB without them", flush=True)
        status, data = self._request(
            "POST",
            f"/jobs/{job_id}/result?{query}",
            raw=glb,
            lease=lease,
            timeout=180.0,
        )
        return status, data

    def report_failure(self, job_id: str, lease: str, code: str, message: str) -> None:
        try:
            self._request(
                "POST",
                f"/jobs/{job_id}/failure",
                payload={"code": str(code)[:100], "message": str(message)[:500]},
                lease=lease,
                timeout=15.0,
            )
        except Exception as err:  # best effort: the lease will recover the job anyway
            print(f"[agent] could not report the failure ({err}); the lease will recover the job", flush=True)

    def release(self, job_id: str, lease: str) -> None:
        try:
            self._request("POST", f"/jobs/{job_id}/release", payload={}, lease=lease, timeout=15.0)
        except Exception:
            pass


class Agent:
    def __init__(self, config: AgentConfig, args) -> None:
        self.config = config
        self.args = args
        self.backend = Backend(config)
        self.engine = None
        self.stop = threading.Event()
        self.current_job: Optional[dict] = None
        self.current_task = None
        self.job_started_at: float = 0.0
        self.jobs_done = 0
        self.work_dir = args.work_dir or os.path.join(
            os.environ.get("TEMP") or os.environ.get("TMP") or HERE, "flora-3d-agent"
        )

    # -- model -------------------------------------------------------------
    def load_engine(self) -> None:
        args = argparse.Namespace(
            triposr_home=self.args.triposr_home,
            model=self.args.model,
            device=self.args.device,
            mc_resolution=self.args.mc_resolution,
            chunk_size=self.args.chunk_size,
            foreground_ratio=self.args.foreground_ratio,
            preview=False,
            debug=self.args.debug,
            segmenter=getattr(self.args, "segmenter", "rembg"),
            diagnostics_dir=getattr(self.args, "diagnostics_dir", "") ,
            no_diagnostics=getattr(self.args, "no_diagnostics", False),
        )
        if not args.triposr_home:
            args.triposr_home = os.path.abspath(os.path.join(HERE, "..", "..", "..", "flora-3d", "TripoSR"))
        worker_mod._ensure_import_paths(args.triposr_home)
        self.engine = worker_mod.Engine(args)
        print(
            f"[agent] loading {args.model} on {args.device} "
            f"(triposr-home={os.path.abspath(args.triposr_home)})",
            flush=True,
        )
        self.engine.load()

    # -- heartbeat ---------------------------------------------------------
    def heartbeat_loop(self) -> None:
        interval = 20.0
        while not self.stop.is_set():
            try:
                state = "busy" if self.current_job else ("idle" if self.engine and self.engine.model else "starting")
                data = self.backend.heartbeat(state, self.current_job, self.engine)
                settings = data.get("settings") or {}
                if settings.get("heartbeatIntervalMs"):
                    interval = max(5.0, settings["heartbeatIntervalMs"] / 1000.0)
                job_answer = data.get("job") or {}
                if job_answer.get("action") in ("abort", "lost") and self.current_task is not None:
                    # The server is authoritative: cancelled, or the lease moved on.
                    self.current_task.cancel_requested = True
            except SystemExit:
                raise
            except Exception as err:
                print(f"[agent] heartbeat failed ({err}); retrying", flush=True)
            self.stop.wait(interval)

    # -- one job -----------------------------------------------------------
    def handle_job(self, job: dict) -> None:
        job_id = job["id"]
        lease = job["lease"]["token"]
        self.current_job = {"id": job_id, "lease": {"token": lease}}
        self.job_started_at = time.time()
        try:
            inputs = self.backend.job_input(job_id, lease)
            images = inputs.get("images") or []
            if not images:
                raise RuntimeError("the server returned no reference images for this job")
            if len(images) > 1:
                # CANDIDATES, not multi-view: worker.Engine hardens each one,
                # scores the masks and consumes exactly ONE. The result records
                # which photograph was used and why the others were not.
                print(
                    f"[agent] {len(images)} candidate views supplied; "
                    "the worker selects one after foreground hardening",
                    flush=True,
                )

            payload = {
                # Every candidate the server chose for this single-image job,
                # with the view labels the selection scores against.
                "images": [
                    {
                        "id": img["id"],
                        "kind": img.get("kind", "original"),
                        "label": img.get("label", ""),
                        "viewAngle": img.get("viewAngle", ""),
                        "data": img["data"],
                    }
                    for img in images
                ],
                "options": {
                    "source": "flora-alchemy-agent",
                    "viewCount": len(images),
                    "resolution": self.args.mc_resolution,
                    "foreground_ratio": self.args.foreground_ratio,
                    "segmenter": getattr(self.args, "segmenter", "rembg"),
                },
            }
            task = worker_mod.Task(id=f"agent-{int(time.time())}-{os.getpid()}")
            self.current_task = task
            with worker_mod.INFER_LOCK:
                if task.cancel_requested:
                    print(f"[agent] job {job_id} cancelled before inference started", flush=True)
                    return
                self.engine.run_task(task, payload)

            if task.status == "succeeded":
                self.deliver(job_id, lease, task)
            elif task.status == "cancelled":
                # The backend told us to stop (or the lease was lost) — its own
                # record is already correct; nothing to report.
                print(f"[agent] job {job_id} stopped locally (cancelled)", flush=True)
            else:
                error = task.error or {}
                self.backend.report_failure(job_id, lease, error.get("code", "AGENT_INFERENCE_FAILED"), error.get("message", "inference failed"))
                print(f"[agent] job {job_id} FAILED: {error.get('code')}: {error.get('message')}", flush=True)
        except Exception as err:
            self.backend.report_failure(job_id, lease, "AGENT_ERROR", str(err)[:500])
            print(f"[agent] job {job_id} errored: {err}", flush=True)
            if self.args.debug:
                traceback.print_exc()
        finally:
            self.current_task = None
            self.current_job = None

    def deliver(self, job_id: str, lease: str, task) -> None:
        glb = bytes(task.glb or b"")
        if not glb:
            self.backend.report_failure(job_id, lease, "AGENT_EMPTY_MODEL", "inference produced no GLB bytes")
            return
        backoff = 5.0
        # The worker's own diagnostics travel with the bytes (bounded, and
        # re-filtered server-side before anything touches a record).
        stats = task.result if isinstance(getattr(task, "result", None), dict) else None
        for attempt in range(1, RESULT_UPLOAD_ATTEMPTS + 1):
            try:
                status, data = self.backend.upload_result(job_id, lease, task.id, glb, stats=stats)
                if status == 200 and data.get("duplicate"):
                    print(f"[agent] job {job_id}: the server already had this result (idempotent retry)", flush=True)
                    return
                if status == 200:
                    self.jobs_done += 1
                    quality = data.get("qualityDecision") or "unrated"
                    print(
                        f"[agent] job {job_id}: uploaded {len(glb) / 1024:.0f} KB → candidate "
                        f"{data.get('assetId')} (quality: {quality}; a human must still approve it)",
                        flush=True,
                    )
                    return
                if status in (409, 404):
                    # Cancelled / lease lost / job gone: the server's record is
                    # authoritative and the bytes must NOT be forced in.
                    print(f"[agent] job {job_id}: result refused (HTTP {status}: {data.get('code')}); dropping", flush=True)
                    self.save_for_recovery(job_id, glb, reason=f"refused: {data.get('code')}")
                    return
                print(f"[agent] job {job_id}: result rejected (HTTP {status}: {data.get('message')})", flush=True)
                return  # a 4xx means the BYTES were refused — retrying would loop
            except Exception as err:
                if attempt >= RESULT_UPLOAD_ATTEMPTS:
                    saved = self.save_for_recovery(job_id, glb, reason=str(err))
                    print(
                        f"[agent] job {job_id}: could not deliver the result ({err}); "
                        f"saved to {saved} for manual recovery",
                        flush=True,
                    )
                    return
                print(f"[agent] job {job_id}: upload attempt {attempt} failed ({err}); retrying in {backoff:.0f}s", flush=True)
                time.sleep(backoff)
                backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)

    def save_for_recovery(self, job_id: str, glb: bytes, reason: str = "") -> str:
        try:
            os.makedirs(self.work_dir, exist_ok=True)
            path = os.path.join(self.work_dir, f"{job_id}-{int(time.time())}.glb")
            with open(path, "wb") as handle:
                handle.write(glb)
            with open(path + ".json", "w", encoding="utf-8") as handle:
                json.dump({"jobId": job_id, "bytes": len(glb), "reason": reason, "savedAt": time.time()}, handle)
            return path
        except Exception as err:
            print(f"[agent] could not even save the GLB for recovery: {err}", flush=True)
            return "(not saved)"

    # -- main loop ---------------------------------------------------------
    def run(self) -> int:
        print(f"[agent] Flora Alchemy remote GPU agent {AGENT_VERSION} — worker id {self.config.worker_id}", flush=True)
        self.load_engine()
        if self.engine.load_error:
            # A model that cannot load must say so on every heartbeat; the
            # studio then shows the agent as online but not model-ready, and
            # claims will be released instead of stranding jobs.
            print(f"[agent] MODEL LOAD FAILED: {self.engine.load_error}", flush=True)

        threading.Thread(target=self.heartbeat_loop, daemon=True).start()
        backoff = 2.0
        while not self.stop.is_set():
            if self.engine.load_error:
                # Do not claim work we cannot run: release immediately so the
                # queue stays honest for a healthy agent (or the operator).
                job = self.backend.claim(self.config.worker_id, 0) if self.backend.connected else None
                if job:
                    self.backend.release(job["id"], job["lease"]["token"])
                    print("[agent] model is not loaded — released the job back to the queue", flush=True)
                self.stop.wait(30.0)
                continue
            try:
                job = self.backend.claim(self.config.worker_id, self.config.poll_wait)
                backoff = 2.0
            except SystemExit:
                raise
            except Exception as err:
                print(f"[agent] claim failed ({err}); backoff {backoff:.0f}s", flush=True)
                self.stop.wait(backoff)
                backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)
                continue
            if not job:
                self.stop.wait(self.config.idle_poll_seconds)
                continue
            print(f"[agent] claimed job {job['id']} (quality={job.get('quality')}, retries={job.get('retryCount', 0)})", flush=True)
            self.handle_job(job)
            if self.args.once:
                print("[agent] --once: exiting after one job", flush=True)
                return 0
        return 0


def diagnose(config: AgentConfig, args) -> int:
    """Report readiness WITHOUT credentials and WITHOUT loading the weights."""
    print("FLORA ALCHEMY REMOTE GPU AGENT — DIAGNOSTIC")
    print("────────────────────────────────────────────")
    print(f"  api url          : {config.api_base or '(NOT SET)'}")
    print(f"  token            : {'set (' + str(len(config.token)) + ' chars)' if len(config.token) >= TOKEN_MIN_LENGTH else 'MISSING or too short'}")
    print(f"  worker id        : {config.worker_id}")
    print(f"  work dir         : {args.work_dir or '(default under %TEMP%)'}")
    try:
        import torch

        print(f"  torch            : {torch.__version__}")
        print(f"  cuda available   : {torch.cuda.is_available()}")
        if torch.cuda.is_available():
            print(f"  gpu              : {torch.cuda.get_device_name(0)}")
            props = torch.cuda.get_device_properties(0)
            # CudaDeviceProperties exposes `total_memory` (bytes); `total_mem` does
            # not exist and would raise AttributeError into the fallback branch.
            print(f"  vram             : {props.total_memory / 1024 / 1024:.0f} MB")
    except Exception as err:
        print(f"  torch            : NOT IMPORTABLE ({err}) — is the worker venv active?")
    if config.api_base and len(config.token) >= TOKEN_MIN_LENGTH:
        backend = Backend(config)

        class _ProbeEngine:
            model = None
            device = "cuda:0"
            gpu_name = ""
            vram_total_mb = 0

        try:
            data = backend.heartbeat("starting", None, _ProbeEngine())
            settings = data.get("settings") or {}
            print(f"  backend          : reachable, heartbeat accepted")
            print(f"  lease/stale      : {settings.get('leaseMs', '?')} ms / {settings.get('staleAfterMs', '?')} ms")
            print(f"  queued jobs      : {(data.get('queue') or {}).get('queued', '?')}")
        except Exception as err:
            print(f"  backend          : UNREACHABLE or refused ({err})")
            return 1
    else:
        print("  backend          : skipped (url/token not configured)")
    print("────────────────────────────────────────────")
    print("  next: start with the same env, then watch the 3D studio's agent chip go online.")
    return 0


def main() -> int:
    # Windows consoles default to a legacy codepage (cp1252); every box-drawing
    # separator this script prints would raise UnicodeEncodeError and kill the
    # process with a traceback. Force UTF-8 (replace, never crash) so --diagnose
    # and normal operation work on an unmodified Windows terminal.
    for stream in (sys.stdout, sys.stderr):
        try:
            if stream and stream.encoding and stream.encoding.lower().replace("-", "") != "utf8":
                stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    parser = argparse.ArgumentParser(description="Flora Alchemy remote GPU agent (TripoSR on this machine)")
    parser.add_argument("--api-url", default="", help="backend /api base (else THREE_WORKER_AGENT_URL)")
    parser.add_argument("--token", default="", help="machine token (else THREE_WORKER_AGENT_TOKEN; never logged)")
    parser.add_argument("--worker-id", default="", help="stable name for this PC (else hostname)")
    parser.add_argument("--triposr-home", default=os.environ.get("TRIPOSR_HOME", ""), help="path to a TripoSR checkout")
    parser.add_argument("--model", default=os.environ.get("THREE_WORKER_MODEL", "stabilityai/TripoSR"))
    parser.add_argument("--device", default=os.environ.get("THREE_WORKER_DEVICE", "cuda:0"))
    parser.add_argument("--mc-resolution", type=int, default=int(os.environ.get("THREE_WORKER_MC_RESOLUTION", "256")))
    parser.add_argument("--chunk-size", type=int, default=int(os.environ.get("THREE_WORKER_CHUNK_SIZE", "8192")))
    parser.add_argument("--foreground-ratio", type=float, default=0.85)
    parser.add_argument(
        "--segmenter",
        default=os.environ.get("THREE_WORKER_SEGMENTER", "rembg"),
        choices=["rembg", "alpha", "photo"],
        help="foreground policy for inference inputs (rembg = fail-closed segmentation)",
    )
    parser.add_argument(
        "--diagnostics-dir",
        default=os.environ.get(
            "THREE_WORKER_DIAGNOSTICS_DIR",
            os.path.join(os.getcwd(), "worker-diagnostics"),
        ),
        help="where original/mask/input diagnostic panels are written (empty = none)",
    )
    parser.add_argument(
        "--no-diagnostics",
        action="store_true",
        default=os.environ.get("THREE_WORKER_NO_DIAGNOSTICS") == "1",
        help="do not write diagnostic image panels",
    )
    parser.add_argument("--poll-wait", type=int, default=15, help="long-poll seconds when the queue is empty (0-20)")
    parser.add_argument("--idle-poll-seconds", type=float, default=5.0, help="sleep after an empty long-poll")
    parser.add_argument("--work-dir", default="", help="where undeliverable GLBs are saved for recovery")
    parser.add_argument("--once", action="store_true", help="handle exactly one job, then exit")
    parser.add_argument("--diagnose", action="store_true", help="print a credential-free readiness report and exit")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    config = AgentConfig(args)
    if args.diagnose:
        return diagnose(config, args)
    config.validate()

    agent = Agent(config, args)
    try:
        return agent.run()
    except KeyboardInterrupt:
        print("[agent] shutting down", flush=True)
        agent.stop.set()
        return 0


if __name__ == "__main__":
    sys.exit(main())
