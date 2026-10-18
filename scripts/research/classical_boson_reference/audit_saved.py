"""Read-only saved-evidence replay; never imports or executes a star solver."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import checker


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('not a regular non-symlink: '+str(path))
    return json.loads(path.read_text(encoding='utf-8'))


def audit(root, freeze_path, freeze_sha, terminal_sha):
    if digest(freeze_path)!=freeze_sha or digest(root/'terminal.json')!=terminal_sha:
        raise ValueError('receipt identity changed')
    freeze=read(freeze_path); terminal=read(root/'terminal.json')
    sources=Path(freeze['source_root'])
    for name,expected in freeze['sources'].items():
        if digest(sources/name)!=expected:
            raise ValueError('frozen source changed: '+name)
    config=read(sources/'case.v1.json')
    if terminal['freeze_sha256']!=freeze_sha or terminal['authority']!=config['authority'] or not terminal['passed']:
        raise ValueError('terminal scope/decision mismatch')
    actual={str(path.relative_to(root)) for path in root.rglob('*') if path.is_file() and path.name!='terminal.json'}
    if actual!=set(terminal['files']):
        raise ValueError('file inventory mismatch')
    for relative,expected in terminal['files'].items():
        path=Path(relative)
        if path.is_absolute() or '..' in path.parts or (root/path).is_symlink() or digest(root/path)!=expected:
            raise ValueError('file identity/path mismatch: '+relative)
    expected_ids=[case['id'] for case in config['solver']['cases']]
    if terminal['completed_cases']!=expected_ids:
        raise ValueError('case schedule mismatch')
    progress=[json.loads(line) for line in (root/'progress.jsonl').read_text().splitlines()]
    expected_phases=[phase for _ in expected_ids for phase in ('case_start','case_checked')]+['study_terminal']
    if [item['phase'] for item in progress]!=expected_phases or any(
            b['elapsed_seconds']<=a['elapsed_seconds'] for a,b in zip(progress,progress[1:])):
        raise ValueError('progress chronology mismatch')
    profiles={}; observations={}; mutation_rejections=[]
    for index,case_id in enumerate(expected_ids):
        if progress[2*index]['case']!=case_id or progress[2*index+1]['case']!=case_id:
            raise ValueError('progress case identity mismatch')
        child=root/case_id
        summary=read(child/'summary.json')
        profile=np.loadtxt(child/'profile.csv',delimiter=',',skiprows=1)
        recomputed=checker.classify(profile,summary,config)
        if not recomputed['passed'] or recomputed!=read(child/'checker.json'):
            raise ValueError('residual/reference replay mismatch: '+case_id)
        child_progress=[json.loads(line) for line in (child/'progress.jsonl').read_text().splitlines()]
        if [item['phase'] for item in child_progress]!=['collocation_start','collocation_terminal'] or \
                child_progress[-1]['monotonic']<=child_progress[0]['monotonic']:
            raise ValueError('child chronology mismatch')
        if read(root/(case_id+'.exit.json'))['returncode']!=0:
            raise ValueError('child exit mismatch')
        # Exact positive evidence is checked before any negative probes.
        for column,label in ((0,'radius_units'),(2,'metric'),(3,'scalar')):
            altered=profile.copy(); altered[:,column]*=2
            if checker.classify(altered,summary,config)['passed']:
                raise ValueError('mutation unexpectedly accepted: '+label)
            mutation_rejections.append(case_id+':'+label)
        changed=dict(summary); changed['omega_normalized']=summary['omega_bare']
        if checker.classify(profile,changed,config)['passed']:
            raise ValueError('bare-frequency mutation accepted')
        mutation_rejections.append(case_id+':frequency')
        profiles[case_id]=profile; observations[case_id]=recomputed['observations']
    # Independently recompute aggregate inequalities, not by importing study.py.
    bands=config['acceptance']['convergence_absolute_bands']
    pairs=[('resolution_medium','resolution_fine'),('domain_inner','resolution_fine'),
           ('domain_outer','resolution_fine'),('origin_large','resolution_fine'),('origin_small','resolution_fine')]
    for first,second in pairs:
        for quantity,band in bands.items():
            if abs(observations[first][quantity]-observations[second][quantity])>band:
                raise ValueError('convergence replay failed: '+quantity)
        grid=np.linspace(.5,40,2049)
        for column in (1,2,3,4,5):
            difference=np.max(np.abs(np.interp(grid,profiles[first][:,0],profiles[first][:,column])
                                   -np.interp(grid,profiles[second][:,0],profiles[second][:,column])))
            if difference>config['acceptance']['profile_absolute_band']:
                raise ValueError('profile convergence replay failed')
    for name in bands:
        first=abs(observations['resolution_coarse'][name]-observations['resolution_medium'][name])
        second=abs(observations['resolution_medium'][name]-observations['resolution_fine'][name])
        if second>max(config['acceptance']['refinement_roundoff_floor'],config['acceptance']['refinement_contraction_max']*first):
            raise ValueError('refinement contraction replay failed')
    if terminal['observations']!=observations['resolution_fine'] or terminal['elapsed_seconds']>config['resources']['study_timeout_seconds']:
        raise ValueError('terminal observations/bounds mismatch')
    return {'schema':'classical-reference-saved-replay/1','passed':True,'file_count':len(actual),
            'case_count':len(expected_ids),'mutations_rejected':mutation_rejections,
            'freeze_sha256':freeze_sha,'terminal_sha256':terminal_sha,
            'observations':observations['resolution_fine'],'authority':config['authority'],
            'scope':'local content/chronology, independent residuals and aggregate replay; not a second solver or interval proof'}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--root',type=Path,required=True); parser.add_argument('--freeze',type=Path,required=True)
    parser.add_argument('--freeze-sha256',required=True); parser.add_argument('--terminal-sha256',required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    result=audit(args.root,args.freeze,args.freeze_sha256,args.terminal_sha256)
    with args.output.open('x',encoding='utf-8',newline='\n') as stream:
        json.dump(result,stream,indent=2,sort_keys=True,allow_nan=False); stream.write('\n')
    print(json.dumps({'passed':result['passed'],'cases':result['case_count'],
                      'mutations_rejected':len(result['mutations_rejected']),'output_sha256':digest(args.output)}))


if __name__=='__main__':
    main()
