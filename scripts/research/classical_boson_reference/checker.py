"""Source-disjoint equations: numerical geometry/stress and KG flux.

This checker deliberately does not import the collocation solver or its RHS.
Seven-point sampled-profile derivatives differ from the solver discretization.
This is independent numerical residual checking, not interval certification.
"""
import math

import numpy as np


def differentiate(samples, spacing, order=1):
    offsets = np.arange(-3, 4, dtype=float)
    matrix = np.array([offsets**k for k in range(7)])
    target = np.zeros(7)
    target[order] = math.factorial(order)
    weights = np.linalg.solve(matrix, target) / spacing**order
    return sum(weights[i] * samples[i:len(samples)-6+i] for i in range(7))


def equation_residuals(profile, omega, scale_floor):
    radius, a, alpha, phi, stored_derivative, stored_mass = profile.T
    spacing = radius[1] - radius[0]
    interior = slice(3, -3)
    r, av, alphav, phiv = radius[interior], a[interior], alpha[interior], phi[interior]
    phi_prime = differentiate(phi, spacing)
    nu_prime = differentiate(np.log(alpha), spacing)
    lambda_prime = differentiate(np.log(a), spacing)
    nu_second = differentiate(np.log(alpha), spacing, 2)
    rho = 0.5 * ((omega**2 / alphav**2 + 1) * phiv**2 + phi_prime**2 / av**2)
    radial_pressure = rho - phiv**2
    tangential_pressure = radial_pressure - phi_prime**2 / av**2
    # Mixed Einstein components with positive density convention -G^t_t.
    density_geometry = (1 - av**-2) / r**2 + 2 * lambda_prime / (r * av**2)
    radial_geometry = -(1 - av**-2) / r**2 + 2 * nu_prime / (r * av**2)
    angular_geometry = (nu_second + nu_prime**2 - nu_prime*lambda_prime
                        + (nu_prime-lambda_prime)/r) / av**2
    # KG conservative flux uses a separately reconstructed phi derivative.
    # Compute flux at inner sample positions, then differentiate again.
    flux = alphav * r**2 / av * phi_prime
    flux_prime = differentiate(flux, spacing)
    flux_source = (alpha * a * radius**2 * (1 - omega**2/alpha**2) * phi)[6:-6]
    pairs = {
        'einstein_density':(r, density_geometry, 8*math.pi*rho),
        'einstein_radial':(r, radial_geometry, 8*math.pi*radial_pressure),
        'einstein_angular':(r, angular_geometry, 8*math.pi*tangential_pressure),
        'scalar_derivative':(r, phi_prime, stored_derivative[interior]),
        'kg_flux':(radius[6:-6], flux_prime, flux_source),
    }
    return pairs


def residual_report(profile, omega, acceptance):
    reports = {}
    for name, (radius, lhs, rhs) in equation_residuals(profile, omega, acceptance['checker_scale_floor']).items():
        mask = (radius >= acceptance['checker_interior'][0]) & (radius <= acceptance['checker_interior'][1])
        scale = max(float(np.max(np.abs(lhs[mask]))), float(np.max(np.abs(rhs[mask]))), acceptance['checker_scale_floor'])
        error = float(np.max(np.abs((lhs-rhs)[mask])))
        reports[name] = {'max_abs':error,'scale':scale,'max_scaled':error/scale,
                         'samples':int(mask.sum()),'passed':error/scale <= acceptance['checker_max_scaled_residual']}
    return reports


def classify(profile, summary, config):
    acceptance = config['acceptance']
    failures = []
    if profile.ndim != 2 or profile.shape != (config['solver']['output_points'],6) or not np.isfinite(profile).all():
        return {'passed':False,'failures':['invalid_profile'],'reference_only':True}
    radius, a, alpha, phi, derivative, mass = profile.T
    spacing = np.diff(radius)
    if np.any(spacing <= 0) or not np.allclose(spacing, spacing[0], rtol=1e-8, atol=1e-12):
        return {'passed':False,'failures':['nonuniform_radius'],'reference_only':True}
    expected_case = next((case for case in config['solver']['cases'] if case == summary['case']), None)
    if expected_case is None:
        return {'passed':False,'failures':['case_identity'],'reference_only':True}
    if abs(radius[0]-expected_case['origin']) > 1e-12 or abs(radius[-1]-expected_case['radius']) > 1e-12:
        return {'passed':False,'failures':['radial_units_or_domain'],'reference_only':True}
    if np.any(a <= 0) or np.any(alpha <= 0):
        return {'passed':False,'failures':['nonpositive_metric'],'reference_only':True}
    omega = summary['omega_normalized']
    if not math.isfinite(omega) or not 0 < omega < 1:
        return {'passed':False,'failures':['not_bound_frequency'],'reference_only':True}
    central_phi = config['conventions']['central_phi']
    compactness = 1-a**-2
    epsilon = radius[0]
    bare = summary['omega_bare']
    origin_density = 0.5 * (bare**2+1)*central_phi**2
    origin_pressure = 0.5 * (bare**2-1)*central_phi**2
    a2 = 4*math.pi/3 * origin_density
    lapse2 = a2/2 + 2*math.pi*origin_pressure
    scalar2 = (1-bare**2)*central_phi/6
    origin_error = max(abs(a[0]-(1+a2*epsilon**2)),
                       abs(alpha[0]*summary['normalization']-(1+lapse2*epsilon**2)),
                       abs(phi[0]-(central_phi+scalar2*epsilon**2)),
                       abs(derivative[0]-2*scalar2*epsilon))
    checks = {
        'solver_success':summary['status']==0,
        'origin_boundary':summary['boundary_max_abs']<=acceptance['origin_boundary_error'],
        'central_phi':abs(phi[0]-0.5*epsilon*derivative[0]-central_phi)<=acceptance['central_phi_error'],
        'independent_origin':origin_error<=acceptance['origin_boundary_error'],
        'nodeless':bool(np.min(phi) >= -acceptance['negative_scalar_relative']*central_phi),
        'tail_small':abs(phi[-1])<=acceptance['tail_amplitude_relative']*central_phi,
        'no_horizon':bool(np.max(compactness)<acceptance['max_compactness']),
        'mass_consistent':bool(np.max(np.abs(mass-radius/2*(1-a**-2)))<1e-10),
        'mass_monotone':bool(np.min(np.diff(mass))>=-1e-9),
        'asymptotic_gauge':abs(alpha[-1]*a[-1]-1)<1e-12,
        'frequency_map':abs(summary['omega_bare']/summary['normalization']-omega)<1e-12,
    }
    # NumPy comparisons return np.bool_, which standard strict JSON rejects.
    # Preserve the predicates exactly; only normalize their wire types.
    checks = {name:bool(value) for name,value in checks.items()}
    observations = {'omega_bare':summary['omega_bare'],'omega_normalized':omega,'mass':float(mass[-1]),
                    'radius_99':float(np.interp(0.99*mass[-1],mass,radius)),
                    'radius_95':float(np.interp(0.95*mass[-1],mass,radius)),
                    'max_compactness':float(np.max(compactness))}
    reference_checks = {}
    for name, band in acceptance['reference_absolute_bands'].items():
        error = abs(observations[name]-config['reference'][name])
        reference_checks[name] = {'observed':observations[name],'reference':config['reference'][name],
                                  'absolute_error':error,'band':band,'passed':error<=band}
    residuals = residual_report(profile, omega, acceptance)
    failures.extend(name for name, passed in checks.items() if not passed)
    failures.extend('reference:'+name for name, value in reference_checks.items() if not value['passed'])
    failures.extend('residual:'+name for name, value in residuals.items() if not value['passed'])
    return {'schema':'classical-reference-checker/1','passed':not failures,'failures':failures,
            'checks':checks,'reference_checks':reference_checks,'residuals':residuals,
            'observations':observations,'reference_only':True,'authority':config['authority']}
