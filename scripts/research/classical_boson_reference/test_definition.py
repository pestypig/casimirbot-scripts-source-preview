"""Preexecution synthetic/analytic tests. Does not solve a reference star."""
import copy
import inspect
import json
import math
import unittest
from unittest.mock import patch
from pathlib import Path

import numpy as np
import checker
import solver

CONFIG = json.loads((Path(__file__).parent/'case.v1.json').read_text())


class DefinitionTests(unittest.TestCase):
    def test_natural_state_scaling_inverse(self):
        scales=solver.state_scales(CONFIG)
        baseline=np.array([1.,1.,0.,0.])
        physical=np.array([[1.001,1.002],[1.003,1.004],[.02,.019],[-.001,-.002]])
        scaled=(physical-baseline[:,None])/scales[:,None]
        np.testing.assert_allclose(solver.physical_state(scaled,scales),physical,atol=1e-15)
        np.testing.assert_allclose(scales,[.0004,.0004,.02,.02],atol=1e-16)

    def test_scaling_rhs_preserves_physical_equations(self):
        scales=solver.state_scales(CONFIG)
        z=np.array([[1.,2.],[2.,3.],[1.,.8],[-.1,-.2]])
        physical=solver.physical_state(z,scales)
        r=np.array([.2,.5])
        original=solver.rhs(r,physical,[1.05])
        scaled_derivative=solver.scaled_rhs(r,z,[1.05],scales)
        np.testing.assert_allclose(scales[:,None]*scaled_derivative,original,atol=1e-15)

    def test_scaled_origin_without_cancellation(self):
        scales=solver.state_scales(CONFIG)
        epsilon=1e-5
        z=solver.scaled_origin(epsilon,1.05,.02)
        self.assertGreater(z[0],0)
        expected_a2=2*math.pi/3*(1.05**2+1)
        self.assertAlmostEqual(z[0]/epsilon**2,expected_a2,places=12)
        physical=solver.physical_state(z[:,None],scales)[:,0]
        np.testing.assert_allclose(physical,solver.origin_values(epsilon,1.05,.02),atol=1e-16)

    def test_quintic_output_manufactured_polynomial(self):
        nodes=np.array([0.1,0.5,1.,2.])
        values=np.tile(nodes**3/3,(4,1))
        with patch.object(solver,'rhs',lambda r,y,p: np.tile(r**2,(4,1))):
            polynomial=solver.dense_output(nodes,values,[0.9])
        grid=np.linspace(nodes[0],nodes[-1],101)
        np.testing.assert_allclose(polynomial(grid),np.tile(grid**3/3,(4,1)).T,atol=1e-13)
        np.testing.assert_allclose(polynomial(grid,2),np.tile(2*grid,(4,1)).T,atol=1e-12)

    def test_quintic_preserves_node_values(self):
        nodes=np.linspace(.1,2,10)
        values=np.array([np.ones(10),np.ones(10),np.full(10,.03),np.zeros(10)])
        output=solver.dense_output(nodes,values,[1.05])
        np.testing.assert_allclose(output(nodes),values.T,atol=1e-14)

    def test_strict_json_report(self):
        profile,summary=self.manufactured_record()
        report=checker.classify(profile,summary,CONFIG)
        json.dumps(report,allow_nan=False)
        self.assertTrue(all(type(value) is bool for value in report['checks'].values()))

    def test_fd_polynomials(self):
        x = np.linspace(-1,1,401)
        for degree in range(1,7):
            np.testing.assert_allclose(checker.differentiate(x**degree,x[1]-x[0]),
                                       degree*x[3:-3]**(degree-1), atol=1e-11)
        np.testing.assert_allclose(checker.differentiate(x**4,x[1]-x[0],2),12*x[3:-3]**2, atol=1e-9)

    def test_vacuum_rhs(self):
        radius = np.array([2.,3.,5.,10.])
        mass = 0.2
        alpha = np.sqrt(1-2*mass/radius)
        a = 1/alpha
        values = np.array([a,alpha,np.zeros(4),np.zeros(4)])
        derivatives = solver.rhs(radius,values,[0.9])
        np.testing.assert_allclose(derivatives[0],-mass/radius**2*a**3,rtol=1e-13)
        np.testing.assert_allclose(derivatives[1],mass/radius**2*a,rtol=1e-13)
        np.testing.assert_array_equal(derivatives[2:],0)

    def test_minkowski_checker(self):
        radius = np.linspace(0.01,50,8193)
        profile = np.column_stack((radius,np.ones_like(radius),np.ones_like(radius),
                                   np.zeros((len(radius),3))))
        reports = checker.residual_report(profile,0.9,CONFIG['acceptance'])
        self.assertTrue(all(item['passed'] for item in reports.values()))

    def test_schwarzschild_checker(self):
        radius = np.linspace(2,50,8193)
        alpha = np.sqrt(1-0.4/radius)
        profile = np.column_stack((radius,1/alpha,alpha,np.zeros((len(radius),2)),np.full_like(radius,0.2)))
        reports = checker.residual_report(profile,0.9,CONFIG['acceptance'])
        self.assertLess(max(item['max_abs'] for item in reports.values()),2e-9)

    def test_kg_flux_manufactured(self):
        radius = np.linspace(0.01,50,8193)
        # In flat space phi=r^2, derivative=2r, KG flux derivative=6r^2.
        profile = np.column_stack((radius,np.ones_like(radius),np.ones_like(radius),radius**2,2*radius,np.zeros_like(radius)))
        pairs = checker.equation_residuals(profile,0.9,1e-8)
        r, flux_prime, _ = pairs['kg_flux']
        np.testing.assert_allclose(flux_prime,6*r**2,atol=1e-6)

    def test_origin_coefficients_against_stress(self):
        for omega in (0.8,1.,1.2):
            phi = 0.03
            rho = (omega**2+1)*phi**2/2
            pressure = (omega**2-1)*phi**2/2
            epsilon = 0.001
            expected = [1+4*math.pi*rho/3*epsilon**2,
                        1+(2*math.pi*rho/3+2*math.pi*pressure)*epsilon**2,
                        phi+(1-omega**2)*phi*epsilon**2/6,
                        (1-omega**2)*phi*epsilon/3]
            np.testing.assert_allclose(solver.origin_values(epsilon,omega,phi),expected,rtol=1e-15)

    def test_rhs_independent_stress_form(self):
        r = np.array([0.1,0.5,1.,4.])
        a=np.array([1.0001,1.001,1.01,1.04]); alpha=np.array([1.,1.01,1.02,1.1])
        phi=np.array([.03,.029,.02,.01]); derivative=np.array([-.001,-.002,-.003,-.004])
        omega=1.05
        mass=r/2*(1-a**-2)
        rho=((omega/alpha)**2*phi**2+phi**2+(derivative/a)**2)/2
        pressure=rho-phi**2
        mass_prime=4*math.pi*r**2*rho
        a_prime=a**3*(mass_prime/r-mass/r**2)
        alpha_prime=alpha*a**2*(mass/r**2+4*math.pi*r*pressure)
        phi_second=-(2/r+alpha_prime/alpha-a_prime/a)*derivative+a**2*(1-(omega/alpha)**2)*phi
        np.testing.assert_allclose(solver.rhs(r,[a,alpha,phi,derivative],[omega]),
                                   [a_prime,alpha_prime,derivative,phi_second],rtol=1e-10,atol=1e-14)

    def test_checker_source_disjoint(self):
        source = inspect.getsource(checker)
        self.assertNotIn('import solver',source)
        self.assertNotIn('solver.rhs',source)

    def manufactured_record(self):
        case=CONFIG['solver']['cases'][2]
        r=np.linspace(case['origin'],case['radius'],CONFIG['solver']['output_points'])
        phi=np.full_like(r,0.02)
        profile=np.column_stack((r,np.ones_like(r),np.ones_like(r),phi,np.zeros((len(r),2))))
        summary={'case':case,'status':0,'boundary_max_abs':0,'omega_normalized':.953910295230624,
                 'omega_bare':1.04984409445897,'normalization':1.04984409445897/.953910295230624}
        return profile,summary

    def test_wrong_radius_units_rejected(self):
        profile,summary=self.manufactured_record()
        profile[:,0]*=2
        result=checker.classify(profile,summary,CONFIG)
        self.assertIn('radial_units_or_domain',result['failures'])

    def test_wrong_frequency_normalization_rejected(self):
        profile,summary=self.manufactured_record()
        summary['omega_normalized']=summary['omega_bare']
        self.assertIn('not_bound_frequency',checker.classify(profile,summary,CONFIG)['failures'])

    def test_corrupt_profile_rejected(self):
        profile,summary=self.manufactured_record()
        profile[100,2]=float('nan')
        self.assertIn('invalid_profile',checker.classify(profile,summary,CONFIG)['failures'])

    def test_excited_branch_rejected(self):
        profile,summary=self.manufactured_record()
        profile[100,3]=-0.001
        self.assertIn('nodeless',checker.classify(profile,summary,CONFIG)['failures'])

    def test_freeze_scope(self):
        self.assertEqual(CONFIG['conventions']['central_phi'],0.02)
        self.assertEqual(len(CONFIG['solver']['cases']),7)
        self.assertFalse(any(CONFIG['authority'][key] for key in CONFIG['authority'] if key not in ('reference_only',)))
        self.assertEqual(CONFIG['conventions']['self_interaction'],0)


if __name__=='__main__':
    unittest.main()
