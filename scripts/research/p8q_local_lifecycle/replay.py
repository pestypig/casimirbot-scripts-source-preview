"""Source-disjoint, read-only lifecycle evidence reader. No fixture imports.

This is an alternative receipt formulation, not another process experiment or
independent human review. Saved bytes cannot prove cloud/provider provenance.
"""
import argparse
import copy
from datetime import datetime
import hashlib
import json
from pathlib import Path

CAP = 131072


def need(value, message):
    if not value:
        raise ValueError(message)


def decode(raw):
    need(type(raw) is bytes and len(raw) <= CAP, 'file byte bound')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            need(key not in result, 'duplicate JSON key')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))


def read(path):
    need(path.is_file() and not path.is_symlink() and path.stat().st_size <= CAP, 'regular bounded file')
    return path.read_bytes()


def clock(record):
    need(record['synthetic_only'] is True and type(record['monotonic_ns']) is int,
         'receipt type/scope')
    date = datetime.fromisoformat(record['utc'])
    need(date.tzinfo is not None, 'UTC chronology')
    return record['monotonic_ns']


def audit_case(files, case, protocol):
    def item(name):
        need(name in files, 'required receipt: ' + name)
        return decode(files[name])
    config = item('case.json')
    need(config == {**protocol, 'case': case}, 'case schedule mutated')
    owner, witness, observer = [item(role + '-ready.json') for role in ('owner', 'witness', 'observer')]
    need(owner['outside_job'] is True and witness['outside_job'] is True, 'independence admission')
    need(len({owner['pid'], witness['pid'], observer['pid']}) == 3, 'distinct process identities')
    for who in (owner, witness, observer):
        need(type(who['pid']) is int and who['pid'] > 0 and type(who['creation']) is int
             and who['creation'] > 0, 'process identity types')
    release = item('release.json')
    need(all(clock(who) <= clock(release) for who in (owner, witness, observer)), 'ready/release chronology')
    names = sorted(name for name in files if name.startswith('progress/') and name.endswith('.json'))
    need(0 < len(names) <= 100, 'bounded progress required')
    previous, last = '0' * 64, clock(release)
    for index, name in enumerate(names, 1):
        need(name == f'progress/{index:06d}.json', 'no missing/duplicate progress')
        record = item(name)
        need(type(record['sequence']) is int and record['sequence'] == index
             and record['previous_sha256'] == previous and record['phase'] == 'synthetic_artifact',
             'progress chain/phase')
        need(clock(record) > last, 'progress chronology')
        last, previous = clock(record), hashlib.sha256(files[name]).hexdigest()
        need(files[name + '.part'] == files[name], 'atomic progress publication')
    shutdown, exited = item('shutdown.json'), item('processes-exited.json')
    need(shutdown['pid'] == owner['pid'] and shutdown['creation'] == owner['creation'], 'shutdown identity')
    need(shutdown['terminated'] is True and type(shutdown['exit_code']) is int
         and shutdown['exit_code'] == protocol['expected_exit'][case], 'owner exit classification')
    need(clock(shutdown) >= last and clock(exited) >= clock(shutdown), 'shutdown chronology')
    need(exited['roles'] == ['owner', 'witness', 'observer']
         and exited['pids'] == [x['pid'] for x in (owner, witness, observer)]
         and exited['creations'] == [x['creation'] for x in (owner, witness, observer)]
         and len(exited['exit_codes']) == 3 and all(type(x) is int for x in exited['exit_codes'])
         and exited['exit_codes'][0] == shutdown['exit_code'] and exited['exit_codes'][1] == 0,
         'all exact processes independently exited')
    completed = case in ('baseline', 'transport_loss', 'observer_killed')
    need(('terminal.json' in files) is completed
         and shutdown['owner_terminal_present'] is completed, 'failure cannot acquire completion')
    if completed:
        terminal = item('terminal.json')
        need(len(names) == protocol['ticks'] and terminal['status'] == 'SYNTHETIC_COMPLETED'
             and type(terminal['last_sequence']) is int and terminal['last_sequence'] == len(names)
             and terminal['last_sha256'] == previous and terminal['scientific_result'] is False,
             'complete synthetic terminal content')
        need(clock(terminal) > last and clock(terminal) <= clock(shutdown), 'terminal publication chronology')
        need(files['terminal.json.part'] == files['terminal.json'], 'atomic terminal publication')
        for stream in ('stdout.txt', 'stderr.txt'):
            need(files[stream] == b'' and terminal[stream[:-4] + '_sha256'] == hashlib.sha256(b'').hexdigest(),
                 'synthetic stream binding')
        need(shutdown['stop_submissions'] == 0 and shutdown['stop_error'] is None,
             'observer loss never requests owner STOP')
    elif case in ('owner_crash', 'torn_terminal'):
        need(len(names) == 8 and shutdown['stop_submissions'] == 0, 'partial retained owner failure')
        need(('terminal.json.part' in files) is (case == 'torn_terminal'), 'torn publication retained')
        if case == 'torn_terminal':
            try:
                decode(files['terminal.json.part'])
            except (ValueError, UnicodeError):
                pass
            else:
                raise ValueError('torn terminal unexpectedly valid')
    else:
        intent, reply = item('stop-intent.json'), item('stop-reply.json')
        need(intent['pid'] == owner['pid'] and intent['creation'] == owner['creation'], 'STOP exact identity')
        need(reply['submissions'] == shutdown['stop_submissions'] == 1
             and reply['error'] == shutdown['stop_error']
             and reply['error'].startswith('TimeoutError:injected acknowledgement loss')
             and shutdown['transaction_passed'] is False, 'uncertain STOP stays failed')
        need(clock(intent) <= clock(reply) <= clock(shutdown), 'independent readback after uncertain STOP')
        need(clock(intent) - clock(release) <= (protocol['witness_stop_seconds'] + 1) * 10**9,
             'bounded local STOP')
        need(clock(intent) - clock(release) >= protocol['witness_stop_seconds'] * 10**9,
             'STOP not earlier than declared local deadline')
    if case in ('transport_loss', 'observer_killed'):
        lost = item('transport-disconnected.json' if case == 'transport_loss' else 'observer-killed.json')
        seen = item('observer-saw-progress.json')
        need(clock(seen) <= clock(lost) < last < clock(shutdown), 'progress survives observer loss')
        need(len(names) > seen['last_sequence'], 'new progress after observer loss')
        if case == 'observer_killed':
            need(lost['pid'] == observer['pid'] and exited['exit_codes'][2] != 0, 'actual observer termination')
    need(not any('harness-failure' in key or 'emergency-stop' in key for key in files), 'no hidden harness failure')
    return {'case': case, 'progress_receipts': len(names), 'exit_code': shutdown['exit_code'],
            'classification': 'SYNTHETIC_COMPLETE' if completed else 'PARTIAL_FAILURE_RETAINED',
            'scientific_result': False}


def audit(root, frozen, freeze_sha, terminal_sha):
    need(hashlib.sha256(read(frozen)).hexdigest() == freeze_sha, 'freeze identity')
    admission = decode(read(frozen))
    need(admission['test_exit'] == 0 and admission['scientific_execution'] is False, 'preexecution tests')
    for name, expected in admission['sources'].items():
        path = Path(__file__).resolve().parents[3] / name
        need(hashlib.sha256(read(path)).hexdigest() == expected, 'current frozen source identity')
    raw = read(root / 'suite-terminal.json')
    need(hashlib.sha256(raw).hexdigest() == terminal_sha, 'suite terminal identity')
    terminal = decode(raw)
    need(terminal['status'] == 'FIXTURE_EXECUTION_COMPLETE_PENDING_REPLAY'
         and terminal['first_failure'] is None and terminal['scientific_result'] is False
         and terminal['cloud_actions'] == 0, 'execution truthfulness')
    observed = {}
    for path in root.rglob('*'):
        need(not path.is_symlink(), 'no linked external evidence')
        if path.is_file() and path.name != 'suite-terminal.json' and path.name != 'suite-terminal.json.part':
            raw = read(path)
            observed[str(path.relative_to(root)).replace('\\', '/')] = {'bytes': len(raw),
                    'sha256': hashlib.sha256(raw).hexdigest()}
    need(observed == terminal['inventory'], 'complete inventory identity')
    need(read(root / 'suite-terminal.json.part') == read(root / 'suite-terminal.json'), 'suite atomic publication')
    protocol = decode(read(Path(__file__).with_name('protocol.v1.json')))
    need(sum(x['bytes'] for x in observed.values()) == terminal['bytes'] <= protocol['suite_cap_bytes']
         and terminal['elapsed_seconds'] <= protocol['suite_limit_seconds'], 'suite resource bounds')
    need([x['case'] for x in terminal['cases']] == protocol['cases'], 'exact six-case schedule')
    need(decode(read(root / 'admission.json'))['freeze_sha256'] == freeze_sha, 'root freeze binding')
    reports, mutations = [], []
    for case in protocol['cases']:
        files = {key[len(case)+1:]: read(root / key) for key in observed if key.startswith(case + '/')}
        reports.append(audit_case(files, case, protocol))
        probes = [('shutdown.json', 'creation', 1), ('shutdown.json', 'terminated', False),
                  ('owner-ready.json', 'outside_job', False), ('progress/000001.json', 'previous_sha256', 'f'*64)]
        for filename, key, value in probes:
            altered = copy.deepcopy(files)
            obj = decode(altered[filename]); obj[key] = value
            altered[filename] = json.dumps(obj, sort_keys=True).encode()
            try:
                audit_case(altered, case, protocol)
            except (ValueError, KeyError):
                mutations.append(case + ':' + key)
            else:
                raise ValueError('mutation unexpectedly accepted')
    return {'schema': 'harmless-lifecycle-replay/1', 'passed': True, 'cases': reports,
            'files_verified': len(observed), 'mutations_rejected': mutations,
            'freeze_sha256': freeze_sha, 'terminal_sha256': terminal_sha,
            'scope': 'harmless local process observations and content replay, not cloud reliability or science',
            'cloud_execution_ready': False, 'scientific_result': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--freeze', type=Path, required=True)
    parser.add_argument('--freeze-sha256', required=True)
    parser.add_argument('--terminal-sha256', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = audit(args.root, args.freeze, args.freeze_sha256, args.terminal_sha256)
    with args.output.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write('\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
