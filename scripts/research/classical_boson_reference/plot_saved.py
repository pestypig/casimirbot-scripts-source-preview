"""Presentation only: read a checked saved profile; do not run any solver."""
import argparse
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--study',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    terminal=json.loads((args.study/'terminal.json').read_text())
    if not terminal['passed']:
        raise ValueError('only plot a passing saved study')
    profile=np.loadtxt(args.study/'resolution_fine'/'profile.csv',delimiter=',',skiprows=1)
    r,a,lapse,phi,derivative,mass=profile.T
    mask=r<=40
    figure,axes=plt.subplots(2,2,figsize=(11,7),layout='constrained')
    figure.suptitle('Classical mini-boson-star reference equilibrium\n4D, free complex field; central amplitude 0.02',fontsize=14)
    axes[0,0].plot(r[mask],phi[mask],color='#2563eb'); axes[0,0].set_ylabel('Unrescaled scalar amplitude phi')
    axes[0,1].plot(r[mask],lapse[mask],label='Lapse alpha',color='#2563eb')
    axes[0,1].plot(r[mask],a[mask],label='Radial metric a',color='#d97706'); axes[0,1].legend(); axes[0,1].set_ylabel('Metric functions')
    axes[1,0].plot(r[mask],mass[mask],color='#059669'); axes[1,0].set_ylabel('Enclosed dimensionless mass')
    axes[1,0].axhline(terminal['observations']['mass'],color='#334155',linestyle='--',linewidth=1)
    axes[1,1].plot(r[mask],2*mass[mask]/r[mask],color='#9333ea'); axes[1,1].set_ylabel('Compactness 2m(r)/r')
    for axis in axes.flat:
        axis.set_xlabel('Dimensionless areal radius mu*r'); axis.grid(alpha=.2); axis.set_xlim(0,40)
    figure.text(.5,-.025,'Checked numerical equilibrium only — not dynamical evolution, a quantum state, or warp viability.',ha='center',fontsize=10)
    with args.output.open('xb') as stream:
        figure.savefig(stream,format='png',dpi=150,bbox_inches='tight')
    plt.close(figure)
    print(str(args.output))


if __name__=='__main__':
    main()
