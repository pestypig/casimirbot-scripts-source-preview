"""Bounded, non-clobbering local reference study; never submits cloud work."""
import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import scipy
import checker

HERE=Path(__file__).resolve().parent
SOURCE_NAMES=['case.v1.json','solver.py','checker.py','test_definition.py','test_study.py','study.py','CONVENTIONS.md']


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    with path.open('x',encoding='utf-8',newline='\n') as stream:
        json.dump(value,stream,indent=2,sort_keys=True,allow_nan=False)
        stream.write('\n')


def runtime():
    return {'python':platform.python_version(),'numpy':np.__version__,'scipy':scipy.__version__,
            'executable':sys.executable,'executable_sha256':digest(Path(sys.executable))}


def freeze(path):
    # Definition tests run before any reference evaluation. Failures are stored.
    tests=subprocess.run([sys.executable,'-B','-m','unittest','discover','-s',str(HERE),
                          '-p','test_*.py','-v'],capture_output=True,text=True,timeout=60)
    receipt={'schema':'classical-reference-preexecution/1','created_utc':datetime.now(timezone.utc).isoformat(),
             'source_root':str(HERE),'sources':{name:digest(HERE/name) for name in SOURCE_NAMES},
             'runtime':runtime(),'definition_tests':{'returncode':tests.returncode,'stdout':tests.stdout,'stderr':tests.stderr},
             'numerical_execution_started':False}
    write_json(path,receipt)
    print(json.dumps({'freeze':str(path),'sha256':digest(path),'tests_returncode':tests.returncode}),flush=True)
    if tests.returncode:
        raise SystemExit(2)


def authenticate(path, expected_digest):
    if path.is_symlink() or not path.is_file() or digest(path)!=expected_digest:
        raise ValueError('preexecution receipt identity mismatch')
    receipt=json.loads(path.read_text(encoding='utf-8'))
    if receipt['definition_tests']['returncode']!=0 or receipt['numerical_execution_started'] is not False:
        raise ValueError('preexecution tests or state not admitted')
    if receipt['source_root']!=str(HERE) or receipt['sources']!={name:digest(HERE/name) for name in SOURCE_NAMES}:
        raise ValueError('source closure changed after freeze')
    if receipt['runtime']!=runtime():
        raise ValueError('runtime changed after freeze')
    return receipt


def aggregate(profiles, reports, config):
    acceptance=config['acceptance']
    failures=[]
    comparisons=[]
    pairs=[('resolution_medium','resolution_fine'),('domain_inner','resolution_fine'),
           ('domain_outer','resolution_fine'),('origin_large','resolution_fine'),
           ('origin_small','resolution_fine')]
    for first,second in pairs:
        checks={}
        for name,band in acceptance['convergence_absolute_bands'].items():
            error=abs(reports[first]['observations'][name]-reports[second]['observations'][name])
            checks[name]={'absolute_difference':error,'band':band,'passed':error<=band}
        comparison_grid=np.linspace(0.5,40,2049)
        error=max(float(np.max(np.abs(np.interp(comparison_grid,profiles[first][:,0],profiles[first][:,column])
                                     -np.interp(comparison_grid,profiles[second][:,0],profiles[second][:,column]))))
                  for column in (1,2,3,4,5))
        checks['profile']={'absolute_difference':error,'band':acceptance['profile_absolute_band'],
                           'passed':error<=acceptance['profile_absolute_band']}
        comparisons.append({'pair':[first,second],'checks':checks})
        failures.extend('convergence:'+first+':'+name for name,value in checks.items() if not value['passed'])
    contraction={}
    for name in acceptance['convergence_absolute_bands']:
        first_error=abs(reports['resolution_coarse']['observations'][name]-reports['resolution_medium']['observations'][name])
        second_error=abs(reports['resolution_medium']['observations'][name]-reports['resolution_fine']['observations'][name])
        limit=max(acceptance['refinement_roundoff_floor'],acceptance['refinement_contraction_max']*first_error)
        contraction[name]={'coarse_medium':first_error,'medium_fine':second_error,'limit':limit,'passed':second_error<=limit}
        if second_error>limit:
            failures.append('refinement:'+name)
    failures.extend('case:'+name for name,value in reports.items() if not value['passed'])
    return {'passed':not failures,'failures':failures,'comparisons':comparisons,'refinement':contraction}


def run_study(freeze_path, freeze_digest, output):
    admitted=authenticate(freeze_path,freeze_digest)
    config=json.loads((HERE/'case.v1.json').read_text(encoding='utf-8'))
    if shutil.disk_usage(output.parent).free<config['resources']['minimum_free_bytes']:
        raise ValueError('insufficient free space before study')
    output.mkdir(parents=False,exist_ok=False)
    started=time.monotonic()
    profiles={}; reports={}
    terminal={'schema':'classical-reference-study/1','passed':False,'reference_only':True,
              'freeze_sha256':freeze_digest,'authority':config['authority']}
    write_json(output/'admission.json',admitted)
    def progress(phase,details):
        receipt={'phase':phase,'elapsed_seconds':time.monotonic()-started,**details}
        with (output/'progress.jsonl').open('a',encoding='utf-8') as stream:
            stream.write(json.dumps(receipt,allow_nan=False)+'\n')
            stream.flush(); os.fsync(stream.fileno())
        print(json.dumps(receipt),flush=True)
    try:
        for case in config['solver']['cases']:
            remaining=config['resources']['study_timeout_seconds']-(time.monotonic()-started)
            if remaining<=0:
                raise TimeoutError('study timeout')
            child_output=output/case['id']
            progress('case_start',{'case':case['id']})
            command=[sys.executable,'-B',str(HERE/'solver.py'),'--config',str(HERE/'case.v1.json'),
                     '--case',case['id'],'--output',str(child_output)]
            write_json(output/(case['id']+'.command.json'),command)
            with (output/(case['id']+'.stdout.txt')).open('x',encoding='utf-8') as stdout, \
                 (output/(case['id']+'.stderr.txt')).open('x',encoding='utf-8') as stderr:
                result=subprocess.run(command,stdout=stdout,stderr=stderr,
                                      timeout=min(remaining,config['resources']['case_timeout_seconds']))
            write_json(output/(case['id']+'.exit.json'),{'returncode':result.returncode})
            if result.returncode:
                raise RuntimeError('solver failed: '+case['id'])
            profile=np.loadtxt(child_output/'profile.csv',delimiter=',',skiprows=1)
            summary=json.loads((child_output/'summary.json').read_text(encoding='utf-8'))
            report=checker.classify(profile,summary,config)
            write_json(child_output/'checker.json',report)
            profiles[case['id']]=profile; reports[case['id']]=report
            progress('case_checked',{'case':case['id'],'passed':report['passed'],
                                     'observations':report.get('observations'),'failures':report['failures']})
            if not report['passed']:
                raise RuntimeError('acceptance failed: '+case['id'])
            if sum(path.stat().st_size for path in output.rglob('*') if path.is_file())>config['resources']['max_output_bytes']:
                raise RuntimeError('output resource limit')
        decision=aggregate(profiles,reports,config)
        write_json(output/'convergence.json',decision)
        terminal.update({'passed':decision['passed'],'failures':decision['failures'],
                         'completed_cases':list(reports),'observations':reports['resolution_fine']['observations']})
    except Exception as error:
        terminal.update({'error_type':type(error).__name__,'error':str(error),'completed_cases':list(reports)})
    terminal['elapsed_seconds']=time.monotonic()-started
    progress('study_terminal',{'passed':terminal['passed'],'error':terminal.get('error')})
    terminal['files']={str(path.relative_to(output)):digest(path) for path in output.rglob('*') if path.is_file()}
    temporary=output/'terminal.json.tmp'
    write_json(temporary,terminal)
    # Exclusive target creation followed by write-through: do not replace evidence.
    if (output/'terminal.json').exists():
        raise ValueError('terminal target already exists')
    temporary.rename(output/'terminal.json')
    print(json.dumps({'terminal':str(output/'terminal.json'),'passed':terminal['passed'],
                      'sha256':digest(output/'terminal.json')}),flush=True)
    return terminal


def main():
    parser=argparse.ArgumentParser()
    modes=parser.add_subparsers(dest='mode',required=True)
    frozen=modes.add_parser('freeze'); frozen.add_argument('--output',type=Path,required=True)
    run=modes.add_parser('run'); run.add_argument('--freeze',type=Path,required=True)
    run.add_argument('--freeze-sha256',required=True); run.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if args.mode=='freeze':
        freeze(args.output)
    else:
        terminal=run_study(args.freeze,args.freeze_sha256,args.output)
        if not terminal['passed']:
            raise SystemExit(2)


if __name__=='__main__':
    main()
