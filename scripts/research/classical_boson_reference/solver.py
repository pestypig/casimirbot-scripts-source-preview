"""Standalone classical reference solver. No NHM2 candidate imports."""
import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
from scipy.integrate import solve_bvp
from scipy.interpolate import BPoly


def origin_values(epsilon, omega, central_phi):
    # Match coefficients of the regular polar-areal ODE at r=0, alpha(0)=1.
    a2 = 2 * math.pi / 3 * (omega * omega + 1) * central_phi**2
    alpha2 = a2 / 2 + math.pi * (omega * omega - 1) * central_phi**2
    phi2 = (1 - omega * omega) * central_phi / 6
    return np.array([1 + a2 * epsilon**2, 1 + alpha2 * epsilon**2,
                     central_phi + phi2 * epsilon**2, 2 * phi2 * epsilon])


def rhs(radius, values, parameters):
    a, alpha, phi, derivative = values
    omega = parameters[0]
    ratio = omega**2 / alpha**2
    a_prime = a / 2 * ((1 - a**2) / radius + 4 * math.pi * radius
                      * (derivative**2 + (ratio + 1) * a**2 * phi**2))
    alpha_prime = alpha / 2 * ((a**2 - 1) / radius + 4 * math.pi * radius
                              * (derivative**2 + (ratio - 1) * a**2 * phi**2))
    derivative_prime = -(1 + a**2 - 4 * math.pi * radius**2 * a**2 * phi**2) \
        * derivative / radius + a**2 * (1 - ratio) * phi
    return np.array([a_prime, alpha_prime, derivative, derivative_prime])


def boundary(left, right, parameters, config, case):
    omega = parameters[0]
    normalized = omega / (right[0] * right[1])
    # Newton iterates can leave the bound-state domain. This smooth-enough
    # continuation is ONLY for iterates; final |omega_norm|<1 is mandatory.
    decay = np.sqrt(max(1 - normalized**2, 1e-12))
    origin = origin_values(case['origin'], omega, config['conventions']['central_phi'])
    return np.concatenate((left - origin, [right[3] + (decay + 1 / case['radius']) * right[2]]))


def initial_guess(radius, config):
    phi_c = config['conventions']['central_phi']
    width = 8.0
    gaussian = np.exp(-radius**2 / (2 * width**2))
    phi = phi_c * gaussian
    derivative = -radius / width**2 * phi
    a = 1 + 0.045 * (radius / width)**2 * np.exp(-radius / width)
    alpha = 1 + 0.1 * (1 - gaussian)
    return np.array([a, alpha, phi, derivative])


def dense_output(radius, values, parameters):
    """C2 quintic Hermite output at unchanged collocation nodes.

    solve_bvp's C1 cubic output is not C2, although our independent angular
    Einstein check differentiates the metric twice. Keep all nodal values;
    reconstruct first and second derivatives from the analytic ODE. The
    checker still differentiates sampled values without importing this RHS.
    """
    first = rhs(radius, values, parameters)
    step = 1e-20
    second = np.imag(rhs(radius + 1j*step, values + 1j*step*first, parameters)) / step
    jets = np.stack((values.T, first.T, second.T), axis=1)
    return BPoly.from_derivatives(radius, jets, extrapolate=False)


def state_scales(config):
    # Natural amplitude ordering: geometry responds at phi_c^2, the field
    # and its derivative at phi_c. Do not use fitted reference outputs.
    amplitude = config['conventions']['central_phi']
    return np.array([amplitude**2, amplitude**2, amplitude, amplitude])


def physical_state(scaled, scales):
    return np.array([1.,1.,0.,0.])[:,None] + scales[:,None]*scaled


def scaled_rhs(radius, values, parameters, scales):
    a, alpha, phi, derivative=physical_state(values,scales)
    delta_a=scales[0]*values[0]
    a_squared_minus_one=delta_a*(2+delta_a)
    ratio=parameters[0]**2/alpha**2
    return np.array([
        a/2*(-a_squared_minus_one/radius+4*math.pi*radius*(derivative**2+(ratio+1)*a**2*phi**2))/scales[0],
        alpha/2*(a_squared_minus_one/radius+4*math.pi*radius*(derivative**2+(ratio-1)*a**2*phi**2))/scales[1],
        derivative/scales[2],
        (-(2+a_squared_minus_one-4*math.pi*radius**2*a**2*phi**2)*derivative/radius
         +a**2*(1-ratio)*phi)/scales[3]])


def scaled_origin(epsilon, omega, amplitude):
    # Evaluate small metric deviations directly, without subtracting two
    # floating-point values nearly equal to one at the coordinate origin.
    a2=2*math.pi/3*(omega**2+1)
    alpha2=a2/2+math.pi*(omega**2-1)
    phi2=(1-omega**2)/6
    return np.array([a2*epsilon**2,alpha2*epsilon**2,
                     1+phi2*epsilon**2,2*phi2*epsilon])


def solve(config, case, progress=None):
    started = time.monotonic()
    radius = np.linspace(case['origin'], case['radius'], case['nodes'])
    if progress:
        progress('collocation_start', {'case':case['id'],'nodes':case['nodes']})
    scales = state_scales(config)
    baseline = np.array([1.,1.,0.,0.])
    scaled_initial = (initial_guess(radius, config)-baseline[:,None])/scales[:,None]
    def scaled_boundary(left, right, parameters):
        outer=boundary(baseline+scales*left,baseline+scales*right,parameters,config,case)[-1]/scales[2]
        return np.concatenate((left-scaled_origin(case['origin'],parameters[0],scales[2]),[outer]))
    result = solve_bvp(lambda r,values,p: scaled_rhs(r,values,p,scales), scaled_boundary,
                       radius, scaled_initial,
                       p=[config['solver']['initial_omega']], tol=case['tol'],
                       bc_tol=min(case['tol'], 1e-10), max_nodes=config['solver']['max_nodes'])
    if progress:
        progress('collocation_terminal', {'case':case['id'],'status':int(result.status),
                                        'iterations':int(result.niter),'nodes':len(result.x),
                                        'elapsed_seconds':time.monotonic()-started})
    grid = np.linspace(case['origin'], case['radius'], config['solver']['output_points'])
    nodal_physical=physical_state(result.y,scales)
    a, alpha_bare, phi, derivative = dense_output(result.x, nodal_physical, result.p)(grid).T
    normalization = alpha_bare[-1] * a[-1]
    profile = np.column_stack((grid, a, alpha_bare / normalization, phi, derivative,
                              grid / 2 * (1 - a**-2)))
    return profile, {'schema':'classical-reference-solver/1','case':case,
                     'status':int(result.status),'message':result.message,
                     'omega_bare':float(result.p[0]),
                     'omega_normalized':float(result.p[0]/normalization),
                     'normalization':float(normalization),
                     'boundary_max_abs':float(np.max(np.abs(boundary(nodal_physical[:,0], nodal_physical[:,-1], result.p, config, case)))),
                     'elapsed_seconds':time.monotonic()-started,'niter':int(result.niter),
                     'mesh_nodes':len(result.x),'max_collocation_residual':float(np.max(result.rms_residuals)),
                     'dense_output':'C2 quintic Hermite; unchanged nodes; complex-step directional second jet',
                     'internal_variables':'Minkowski deviations / phi_c^2; scalar variables / phi_c; physical outputs unchanged',
                     'reference_only':True,'authority':config['authority']}


def write_json(path, value):
    with path.open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write('\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--case', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding='utf-8'))
    case = next(item for item in config['solver']['cases'] if item['id'] == args.case)
    output = Path(args.output)
    output.mkdir(parents=False, exist_ok=False)
    def progress(phase, details):
        item = {'phase':phase,'monotonic':time.monotonic(),**details}
        with (output/'progress.jsonl').open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(item, allow_nan=False)+'\n')
        print(json.dumps(item), flush=True)
    profile, summary = solve(config, case, progress)
    with (output/'profile.csv').open('x', encoding='utf-8', newline='\n') as stream:
        np.savetxt(stream, profile, delimiter=',', header='radius,a,alpha,phi,phi_prime,mass', comments='', fmt='%.17g')
    write_json(output/'summary.json', summary)
    if summary['status'] != 0:
        raise SystemExit(2)


if __name__ == '__main__':
    main()
