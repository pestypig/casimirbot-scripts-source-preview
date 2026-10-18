"""One-shot Windows harmless lifecycle fixture. No SDK, Docker or science.

WMI process ownership is reused from the existing tested primitive. Each case
has one observer, one synthetic owner and one independent bounded witness.
Receipts are immutable, fsynced then hard-linked into visibility; .part files
remain retained. This tests process loss, not power-loss durability or security
against a malicious local writer.
"""
import argparse
import ctypes
from ctypes import wintypes
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(REPO))
from scripts.nhm2.p8q_detached_host_v2 import spawn_once
from scripts.nhm2.p8q_detached_host_v1 import outside_job

SOURCES = [HERE / n for n in ('protocol.v1.json', 'fixture.py', 'replay.py',
           'seams.py', 'test_lifecycle.py', 'README.md')] + [
    REPO / 'scripts/nhm2/p8q_detached_host_v1.py',
    REPO / 'scripts/nhm2/p8q_detached_host_v2.py',
    REPO / 'scripts/nhm2/p8q_host_controller_v2.py']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 131072:
        raise ValueError('bounded regular receipt required')
    return json.loads(path.read_bytes())


def publish(path, value):
    raw = (json.dumps(value, sort_keys=True, allow_nan=False,
                      separators=(',', ':')) + '\n').encode('utf-8')
    if len(raw) > 131072:
        raise ValueError('receipt cap')
    if path.exists() or path.is_symlink():
        raise FileExistsError(path)
    part = Path(str(path) + '.part')
    with part.open('xb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    os.link(part, path)  # no replacement and no partial published JSON


def stamp(**value):
    return {'utc': datetime.now(timezone.utc).isoformat(),
            'monotonic_ns': time.perf_counter_ns(), 'synthetic_only': True, **value}


class Process:
    """Hold the exact Windows kernel process object, not a reusable PID."""
    def __init__(self, pid, expected_creation=None):
        if os.name != 'nt' or type(pid) is not int or not 0 < pid < 2**32:
            raise ValueError('Windows process identity')
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        k = self.kernel
        k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k.OpenProcess.restype = wintypes.HANDLE
        k.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        k.GetProcessTimes.restype = wintypes.BOOL
        k.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        k.GetExitCodeProcess.restype = wintypes.BOOL
        k.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        k.TerminateProcess.restype = wintypes.BOOL
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        self.handle = k.OpenProcess(0x1000 | 0x0001, False, pid)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        fields = [wintypes.FILETIME() for _ in range(4)]
        if not k.GetProcessTimes(self.handle, *[ctypes.byref(x) for x in fields]):
            self.close()
            raise ctypes.WinError(ctypes.get_last_error())
        self.pid = pid
        self.creation = (fields[0].dwHighDateTime << 32) | fields[0].dwLowDateTime
        if expected_creation is not None and self.creation != expected_creation:
            self.close()
            raise ValueError('process creation identity mismatch; never terminate substitute')

    def code(self):
        code = wintypes.DWORD()
        if not self.kernel.GetExitCodeProcess(self.handle, ctypes.byref(code)):
            raise ctypes.WinError(ctypes.get_last_error())
        return None if code.value == 259 else code.value

    def stop(self):
        if self.code() is not None:
            raise ValueError('process already exited; no repeat termination')
        if not self.kernel.TerminateProcess(self.handle, 9):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def ready(root, role):
    process = Process(os.getpid())
    try:
        value = stamp(pid=process.pid, creation=process.creation, outside_job=outside_job())
        publish(root / (role + '-ready.json'), value)
        if role in ('owner', 'witness') and value['outside_job'] is not True:
            raise ValueError('independent process still in tool job')
        return value
    finally:
        process.close()


def wait_file(path, seconds):
    deadline = time.monotonic() + seconds
    while not path.is_file():
        if time.monotonic() >= deadline:
            raise TimeoutError('receipt wait: ' + path.name)
        time.sleep(0.02)
    return load(path)


def owner(root):
    config = load(root / 'case.json')
    ready(root, 'owner')
    wait_file(root / 'release.json', config['launch_ready_limit_seconds'])
    began = time.monotonic()
    previous = '0' * 64
    count = 0
    while True:
        count += 1
        path = root / 'progress' / f'{count:06d}.json'
        publish(path, stamp(sequence=count, phase='synthetic_artifact', previous_sha256=previous))
        previous = sha(path)
        if config['case'] == 'owner_crash' and count == 8:
            os._exit(42)
        if config['case'] == 'torn_terminal' and count == 8:
            with (root / 'terminal.json.part').open('xb') as stream:
                stream.write(b'{"deliberately_incomplete":')
                stream.flush()
                os.fsync(stream.fileno())
            os._exit(43)
        if config['case'] != 'deadline_uncertain_stop' and count == config['ticks']:
            publish(root / 'terminal.json', stamp(status='SYNTHETIC_COMPLETED',
                    last_sequence=count, last_sha256=previous,
                    stdout_sha256=sha(root / 'stdout.txt'), stderr_sha256=sha(root / 'stderr.txt'),
                    scientific_result=False))
            return
        if time.monotonic() - began > config['owner_self_limit_seconds']:
            os._exit(44)
        time.sleep(config['tick_seconds'])


def witness(root):
    config = load(root / 'case.json')
    ready(root, 'witness')
    who = wait_file(root / 'owner-ready.json', config['launch_ready_limit_seconds'])
    process = Process(who['pid'], who['creation'])
    try:
        wait_file(root / 'release.json', config['launch_ready_limit_seconds'])
        stop_at = time.monotonic() + config['witness_stop_seconds']
        stop_count = 0
        stop_error = None
        while process.code() is None:
            if time.monotonic() >= stop_at:
                stop_count += 1
                publish(root / 'stop-intent.json', stamp(pid=who['pid'], creation=who['creation']))
                try:
                    process.stop()
                    if config['case'] == 'deadline_uncertain_stop':
                        raise TimeoutError('injected acknowledgement loss after actual termination')
                except Exception as error:
                    stop_error = type(error).__name__ + ':' + str(error)
                publish(root / 'stop-reply.json', stamp(error=stop_error, submissions=stop_count))
                break
            time.sleep(0.02)
        # Never skip this independent state check after a failed/uncertain STOP.
        until = time.monotonic() + 2
        while process.code() is None and time.monotonic() < until:
            time.sleep(0.02)
        code = process.code()
        publish(root / 'shutdown.json', stamp(pid=who['pid'], creation=who['creation'],
                exit_code=code, terminated=code is not None, stop_submissions=stop_count,
                stop_error=stop_error, owner_terminal_present=(root / 'terminal.json').is_file(),
                transaction_passed=stop_error is None and code == 0))
        if code is None:
            raise ValueError('shutdown not observed')
    finally:
        process.close()


def observer(root):
    for role in ('owner', 'witness'):
        directory = root / (role + '-launch')
        directory.mkdir(exist_ok=False)
        spawn_once([sys.executable, '-B', str(Path(__file__).resolve()), '--role', role,
                    '--root', str(root)], directory=directory, cwd=REPO)
    ready(root, 'observer')
    config = load(root / 'case.json')
    wait_file(root / 'release.json', config['launch_ready_limit_seconds'])
    while not (root / 'shutdown.json').is_file():
        files = sorted((root / 'progress').glob('*.json'))
        if len(files) >= 2 and not (root / 'observer-saw-progress.json').exists():
            publish(root / 'observer-saw-progress.json', stamp(last_sequence=len(files)))
            if config['case'] == 'transport_loss':
                publish(root / 'transport-disconnected.json', stamp())
                return
        time.sleep(0.02)


def source_hashes():
    return {str(p.relative_to(REPO)).replace('\\', '/'): sha(p) for p in SOURCES}


def freeze(path):
    result = subprocess.run([sys.executable, '-B', '-m', 'unittest', 'discover',
                            '-s', str(HERE), '-p', 'test_*.py', '-v'],
                            capture_output=True, text=True, timeout=60, cwd=REPO)
    publish(path, stamp(schema='harmless-lifecycle-preexecution/1', sources=source_hashes(),
            python_sha256=sha(Path(sys.executable)), python_executable=sys.executable,
            test_exit=result.returncode, tests_stdout=result.stdout, tests_stderr=result.stderr,
            scientific_execution=False))
    print(json.dumps({'freeze_sha256': sha(path), 'test_exit': result.returncode}), flush=True)
    if result.returncode:
        raise SystemExit(2)


def run(root, frozen, digest):
    if sha(frozen) != digest:
        raise ValueError('freeze identity')
    admission = load(frozen)
    if admission['sources'] != source_hashes() or admission['test_exit'] != 0 or (
            admission['python_executable'] != sys.executable or admission['python_sha256'] != sha(Path(sys.executable))):
        raise ValueError('source/runtime admission')
    if os.name != 'nt' or not root.is_absolute() or root.exists() or root.is_symlink():
        raise ValueError('Windows exclusive root required')
    protocol = load(HERE / 'protocol.v1.json')
    if shutil.disk_usage(root.parent).free < protocol['minimum_free_bytes']:
        raise ValueError('storage admission')
    root.mkdir(exist_ok=False)
    publish(root / 'admission.json', stamp(freeze_sha256=digest, sources=admission['sources'],
            benchmark_terminal_sha256='fec563b284afbf8cfdc393eddece907afcf3e4da7759217d33efbed6b1744a32',
            artifact_shape_only=True, benchmark_reexecuted=False))
    start = time.monotonic()
    summaries = []
    failure = None
    for case in protocol['cases']:
        case_root = root / case
        case_root.mkdir()
        (case_root / 'progress').mkdir()
        publish(case_root / 'case.json', {**protocol, 'case': case})
        for stream in ('stdout.txt', 'stderr.txt'):
            with (case_root / stream).open('xb'):
                pass
        refs = []
        parent = None
        try:
            case_start = time.monotonic()
            parent = subprocess.Popen([sys.executable, '-B', str(Path(__file__).resolve()),
                    '--role', 'observer', '--root', str(case_root)], cwd=REPO,
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    creationflags=subprocess.CREATE_NO_WINDOW)
            for role in ('owner', 'witness', 'observer'):
                who = wait_file(case_root / (role + '-ready.json'), protocol['launch_ready_limit_seconds'])
                refs.append(Process(who['pid'], who['creation']))
            publish(case_root / 'release.json', stamp())
            if case == 'observer_killed':
                wait_file(case_root / 'observer-saw-progress.json', 3)
                parent.terminate()
                parent.wait(timeout=2)
                publish(case_root / 'observer-killed.json', stamp(pid=parent.pid))
            shutdown = wait_file(case_root / 'shutdown.json', 8)
            if not shutdown['terminated'] or shutdown['exit_code'] != protocol['expected_exit'][case]:
                raise ValueError('unexpected owner exit')
            until = time.monotonic() + 3
            while any(ref.code() is None for ref in refs) and time.monotonic() < until:
                time.sleep(0.02)
            codes = [ref.code() for ref in refs]
            if any(code is None for code in codes):
                raise ValueError('owned process remains live')
            if time.monotonic() - case_start > protocol['case_limit_seconds']:
                raise ValueError('case deadline')
            publish(case_root / 'processes-exited.json', stamp(roles=['owner', 'witness', 'observer'],
                    pids=[ref.pid for ref in refs], creations=[ref.creation for ref in refs], exit_codes=codes))
            summaries.append({'case': case, 'expected_exit_observed': True})
        except BaseException as error:
            failure = type(error).__name__ + ':' + str(error)[:200]
            publish(case_root / 'harness-failure.json', stamp(error=failure))
        finally:
            # Only exact retained process handles may receive emergency cleanup.
            for ref in refs:
                try:
                    if ref.code() is None:
                        ref.stop()
                        publish(case_root / f'emergency-stop-{ref.pid}.json', stamp(pid=ref.pid))
                finally:
                    ref.close()
            if parent is not None and parent.poll() is None:
                parent.terminate()
                parent.wait(timeout=3)
        if failure:
            break
        if time.monotonic() - start > protocol['suite_limit_seconds']:
            failure = 'suite deadline'
            break
    inventory = {str(p.relative_to(root)).replace('\\', '/'): {'bytes': p.stat().st_size, 'sha256': sha(p)}
                 for p in root.rglob('*') if p.is_file()}
    size = sum(item['bytes'] for item in inventory.values())
    if size > protocol['suite_cap_bytes']:
        failure = failure or 'suite storage cap'
    publish(root / 'suite-terminal.json', stamp(status='FAIL' if failure else 'FIXTURE_EXECUTION_COMPLETE_PENDING_REPLAY',
            first_failure=failure, cases=summaries, elapsed_seconds=time.monotonic()-start,
            bytes=size, inventory=inventory, scientific_result=False, cloud_actions=0))
    print(json.dumps({'status': 'FAIL' if failure else 'PENDING_REPLAY', 'root': str(root),
                     'terminal_sha256': sha(root / 'suite-terminal.json')}), flush=True)
    if failure:
        raise SystemExit(2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--role', choices=('observer', 'owner', 'witness'))
    parser.add_argument('--root', type=Path)
    parser.add_argument('--freeze', type=Path)
    parser.add_argument('--admission', type=Path)
    parser.add_argument('--admission-sha256')
    args = parser.parse_args()
    if args.role:
        {'observer': observer, 'owner': owner, 'witness': witness}[args.role](args.root)
    elif args.freeze:
        freeze(args.freeze)
    else:
        run(args.root, args.admission, args.admission_sha256)


if __name__ == '__main__':
    main()
