"""Inert seam/analytic receipt tests before any live harmless fixture."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import fixture
import replay
import seams
from scripts.nhm2.p8q_host_controller_v2 import HostController, HostTransport


def manufactured(case):
    """Analytic receipt grammar only; not actual process or cloud evidence."""
    config = fixture.load(fixture.HERE / 'protocol.v1.json')
    files = {}
    def put(name, value, nanos, *, atomic=True):
        record = {'utc':'2026-10-06T12:00:00+00:00', 'monotonic_ns':nanos,
                  'synthetic_only':True, **value}
        files[name] = json.dumps(record, sort_keys=True).encode()
        if atomic: files[name+'.part'] = files[name]
    for i, role in enumerate(('owner','witness','observer'), 1):
        put(role+'-ready.json', {'pid':i,'creation':100+i,'outside_job':role != 'observer'}, i)
    files['case.json'] = json.dumps({**config,'case':case}).encode()
    put('release.json', {}, 10**9)
    completed = case in ('baseline','transport_loss','observer_killed')
    count = config['ticks'] if completed else 8
    prev = '0'*64
    for i in range(1,count+1):
        name = f'progress/{i:06d}.json'
        put(name, {'sequence':i,'previous_sha256':prev,'phase':'synthetic_artifact'}, 10**9+i*80_000_000)
        prev = hashlib.sha256(files[name]).hexdigest()
    for stream in ('stdout.txt','stderr.txt'): files[stream] = b''
    if completed:
        put('terminal.json', {'status':'SYNTHETIC_COMPLETED','last_sequence':count,
            'last_sha256':prev,'scientific_result':False,'stdout_sha256':hashlib.sha256(b'').hexdigest(),
            'stderr_sha256':hashlib.sha256(b'').hexdigest()}, 4*10**9)
    if case == 'torn_terminal': files['terminal.json.part'] = b'{'
    stopped = case == 'deadline_uncertain_stop'
    error = 'TimeoutError:injected acknowledgement loss after actual termination' if stopped else None
    if stopped:
        put('stop-intent.json', {'pid':1,'creation':101}, 5*10**9)
        put('stop-reply.json', {'submissions':1,'error':error}, 5*10**9+1)
    put('shutdown.json', {'pid':1,'creation':101,'terminated':True,
        'exit_code':config['expected_exit'][case], 'stop_submissions':int(stopped),
        'stop_error':error,'transaction_passed':completed,'owner_terminal_present':completed}, 6*10**9)
    put('processes-exited.json', {'roles':['owner','witness','observer'], 'pids':[1,2,3],
        'creations':[101,102,103], 'exit_codes':[config['expected_exit'][case],0,1 if case=='observer_killed' else 0]},
        6*10**9+1)
    if case in ('transport_loss','observer_killed'):
        put('observer-saw-progress.json', {'last_sequence':2}, 1_200_000_000)
        put('transport-disconnected.json' if case=='transport_loss' else 'observer-killed.json',
            {'pid':3}, 1_250_000_000)
    return files, config


class FakePort:
    """Only injected methods; no SDK, Docker or scientific effects."""
    stop_at = None
    attempt = 'synthetic-local-only'
    def __init__(self):
        self.calls = []; self.failure = None; self.stop_error = None; self.shutdown_error = None
    def preflight(self): self.calls.append('preflight')
    def bind_image_once(self): self.calls.append('bind')
    def create_once(self): self.calls.append('create'); self.stop_at = 'injected-only'
    def observe_running(self): self.calls.append('running'); return {'fixture': True}
    def observe_ready(self):
        self.calls.append('ready')
        raise ValueError('injected interruption; no scientific result')
    def stop_once(self):
        self.calls.append('stop')
        if self.stop_error: raise self.stop_error
    def observe_shutdown(self):
        self.calls.append('observe')
        if self.shutdown_error: raise self.shutdown_error
        return {'status': 'TERMINATED', 'synthetic_only': True}
    def _record(self, name, value): self.calls.append('record'); self.result = value


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_atomic_complete_publication(self):
        path = self.root / 'receipt.json'
        fixture.publish(path, {'synthetic': True})
        self.assertEqual(path.read_bytes(), Path(str(path)+'.part').read_bytes())
        self.assertEqual(replay.decode(path.read_bytes()), {'synthetic': True})

    def test_publication_never_overwrites(self):
        path = self.root / 'receipt.json'
        fixture.publish(path, {'first': 1})
        old = path.read_bytes()
        with self.assertRaises(FileExistsError): fixture.publish(path, {'second': 2})
        self.assertEqual(path.read_bytes(), old)

    def test_failed_publication_retains_partial_not_final(self):
        path = self.root / 'receipt.json'
        with patch.object(fixture.os, 'link', side_effect=OSError('injected')):
            with self.assertRaises(OSError): fixture.publish(path, {'first': 1})
        self.assertFalse(path.exists())
        self.assertTrue(Path(str(path)+'.part').is_file())

    def test_existing_partial_blocks_retry(self):
        path = self.root / 'receipt.json'
        Path(str(path)+'.part').write_bytes(b'partial fixture only')
        with self.assertRaises(FileExistsError): fixture.publish(path, {'retry': True})
        self.assertFalse(path.exists())

    def test_json_duplicate_rejected(self):
        with self.assertRaisesRegex(ValueError, 'duplicate'): replay.decode(b'{"x":1,"x":2}')

    def test_json_nonfinite_rejected(self):
        with self.assertRaises(ValueError): replay.decode(b'{"x":NaN}')

    def test_json_byte_cap(self):
        with self.assertRaises(ValueError): replay.decode(b' '*(replay.CAP+1))

    def test_immutable_synthetic_schedule(self):
        config = fixture.load(fixture.HERE / 'protocol.v1.json')
        self.assertEqual(len(config['cases']), 6)
        self.assertFalse(config['authority']['numerical_execution'])
        self.assertFalse(config['authority']['cloud_actions'])
        self.assertLess(config['witness_stop_seconds'], config['owner_self_limit_seconds'])

    def test_sdk_console_seam_preserves_request(self):
        calls = []
        sentinel = object()
        def runner(argv, **kwargs): calls.append((argv, kwargs)); return sentinel
        argv = ['inert', 'data-only']
        env = {'fixture': 'no credentials'}
        result = seams.isolated_runner(runner)(argv, env=env, timeout=31, check=False)
        self.assertIs(result, sentinel)
        self.assertEqual(calls, [(argv, {'env':env,'timeout':31,'check':False,
                                        'creationflags':subprocess.CREATE_NO_WINDOW})])

    def test_sdk_seam_does_not_retry_timeout(self):
        calls = []
        def runner(*args, **kwargs): calls.append(args); raise subprocess.TimeoutExpired(args[0], 1)
        with self.assertRaises(subprocess.TimeoutExpired): seams.isolated_runner(runner)(['inert'], timeout=1)
        self.assertEqual(len(calls), 1)

    def test_sdk_seam_rejects_conflicting_policy(self):
        def runner(*a, **k): self.fail('effect reached')
        with self.assertRaises(ValueError): seams.isolated_runner(runner)(['inert'], creationflags=0)

    def test_stop_uncertainty_stays_failed_but_reads_state(self):
        port = FakePort(); port.stop_error = TimeoutError('injected')
        result = seams.cleanup_once(port)
        self.assertEqual(port.calls, ['stop', 'observe'])
        self.assertFalse(result['transaction_passed'])
        self.assertEqual(result['shutdown']['status'], 'TERMINATED')

    def test_stop_guard_failure_still_observes_without_bypass(self):
        port = FakePort(); port.stop_error = ValueError('identity not verified; STOP not submitted')
        result = seams.cleanup_once(port)
        self.assertEqual(port.calls, ['stop', 'observe'])
        self.assertFalse(result['transaction_passed'])

    def test_shutdown_read_failure_cannot_pass(self):
        port = FakePort(); port.shutdown_error = TimeoutError('injected')
        result = seams.cleanup_once(port)
        self.assertIsNone(result['shutdown'])
        self.assertFalse(result['transaction_passed'])

    def test_actual_controller_observes_after_uncertain_stop(self):
        port = FakePort(); port.stop_error = TimeoutError('ack lost')
        result = HostController(port).run_once()
        self.assertEqual(result['status'], 'FAIL')
        self.assertEqual(result['shutdown']['status'], 'TERMINATED')
        self.assertEqual(port.calls[-3:], ['stop', 'observe', 'record'])

    def test_actual_controller_consumed(self):
        port = FakePort(); controller = HostController(port); controller.run_once()
        before = list(port.calls)
        with self.assertRaises(ValueError): controller.run_once()
        self.assertEqual(before, port.calls)

    def test_actual_stop_guard_interruption_submits_no_stop(self):
        # Reproduce the evidenced pre-STOP consumption boundary with no SDK,
        # archive read, constructor, cloud identity or live transport.
        port = object.__new__(HostTransport)
        port.stop_at = 'injected-only'
        port.stop_consumed = False
        calls = []
        def interrupted():
            calls.append('identity_read')
            raise TimeoutError('injected identity read interruption')
        port.resource = interrupted
        port.call = lambda *a, **k: self.fail('unverified STOP reached')
        with self.assertRaises(TimeoutError): port.stop_once()
        self.assertTrue(port.stop_consumed)
        self.assertEqual(calls, ['identity_read'])
        # No re-grant/retry is inferred from the unsubmitted STOP.
        with self.assertRaises(ValueError): port.stop_once()
        self.assertEqual(calls, ['identity_read'])

    def test_process_identity_rejects_reused_pid(self):
        process = fixture.Process(os.getpid())
        try:
            with self.assertRaisesRegex(ValueError, 'creation identity'):
                fixture.Process(os.getpid(), process.creation + 1)
            self.assertIsNone(process.code())
        finally: process.close()

    def test_reader_source_disjoint(self):
        source = Path(replay.__file__).read_text(encoding='utf-8')
        self.assertNotIn('import fixture', source)
        self.assertNotIn('import seams', source)
        self.assertNotIn('subprocess', source)

    def test_manufactured_six_case_reader_grammar(self):
        for case in fixture.load(fixture.HERE / 'protocol.v1.json')['cases']:
            with self.subTest(case=case):
                files, config = manufactured(case)
                self.assertFalse(replay.audit_case(files, case, config)['scientific_result'])

    def test_reader_rejects_identity_scope_exit_chain_and_chronology_mutations(self):
        files, config = manufactured('baseline')
        for filename, key, value in [('owner-ready.json','outside_job',False),
            ('shutdown.json','creation',999), ('shutdown.json','terminated',False),
            ('shutdown.json','exit_code',42), ('processes-exited.json','exit_codes',[None,0,0]),
            ('terminal.json','scientific_result',True), ('terminal.json','last_sequence',True),
            ('progress/000001.json','previous_sha256','f'*64),
            ('progress/000001.json','monotonic_ns',0)]:
            with self.subTest(key=key):
                altered = copy.deepcopy(files)
                obj = replay.decode(altered[filename]); obj[key] = value
                altered[filename] = json.dumps(obj).encode()
                with self.assertRaises(ValueError): replay.audit_case(altered,'baseline',config)

    def test_reader_rejects_missing_progress_or_terminal(self):
        files, config = manufactured('baseline')
        for name in ('progress/000003.json','terminal.json'):
            altered = copy.deepcopy(files); del altered[name]
            with self.assertRaises(ValueError): replay.audit_case(altered,'baseline',config)

    def test_reader_rejects_progress_not_surviving_observer_loss(self):
        files, config = manufactured('observer_killed')
        obj = replay.decode(files['observer-killed.json']); obj['monotonic_ns'] = 7*10**9
        files['observer-killed.json'] = json.dumps(obj).encode()
        with self.assertRaises(ValueError): replay.audit_case(files,'observer_killed',config)

    def test_uncertain_stop_cannot_be_relabelled_success(self):
        files, config = manufactured('deadline_uncertain_stop')
        obj = replay.decode(files['shutdown.json']); obj['transaction_passed'] = True
        files['shutdown.json'] = json.dumps(obj).encode()
        with self.assertRaises(ValueError): replay.audit_case(files,'deadline_uncertain_stop',config)

    def test_torn_terminal_cannot_be_published_as_complete(self):
        files, config = manufactured('torn_terminal'); files['terminal.json'] = b'{}'
        with self.assertRaises(ValueError): replay.audit_case(files,'torn_terminal',config)


if __name__ == '__main__':
    unittest.main()
